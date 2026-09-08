// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf Hono entry (GPL-3.0)
// 依据 plan.md §9.3 预留路由结构。已实现：/healthz、/api/v1/search（纯向量+rerank+缓存+熔断）、
// /api/v1/corpora（T2.1）、/api/v1/tree/:wiki_id（T2.4）、Queue consumer + Cron（T2.2 增量管线）。
// 其余路由登记为占位/未实现（返回 501 not-yet），待 M3 填充。
import { Hono } from "hono"
import { cors } from "hono/cors"
import { Env, SearchRequest } from "./types"
import { runSearch, SearchValidationError } from "./search"
import { listWikis, collectionName, isValidCorpus, buildCorporaResponse } from "./wiki_registry"
import { fetchAllChunks, buildTree, QdrantScrollError } from "./tree"
import { ingestWiki, type IngestMessage } from "./ingest/incremental"

export const app = new Hono<{ Bindings: Env }>()

// ── CORS（沿用旧版思想，搬前端 &work 形式）──
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS ?? "http://localhost,http://127.0.0.1")
        .split(",")
        .map((s: string) => s.trim())
      if (allowed.includes("*")) return origin
      if (allowed.includes(origin)) return origin
      return allowed[0] ?? ""
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
)

app.onError((err, c) => {
  // 关键：绝不回显 key / secret。错误体只暴露泛化信息。
  console.error(`Unhandled error: ${(err as Error).message ?? String(err)}`)
  return c.json({ error: "internal-error" }, 500)
})

// ── 健康检查 ──
app.get("/healthz", (c) => c.json({ ok: true }))

// ── v1 路由前缀（M0 只做 /api/v1/search 占位 + 其余登记为 not-yet）──
const api = new Hono<{ Bindings: Env }>()

api.get("/corpora", async (c) => {
  // T2.1：每库统计（chunk 数取 Qdrant collection points_count；doc 数与 last_updated 从 D1 最优，
  // 当前无 D1 时归零/null——统计注入点，后续接 D1 ingest_runs 后填真值）。
  const stats = new Map<string, { document_count: number; chunk_count: number; last_updated: string | null }>()
  const qdrantUrl = c.env.QDRANT_URL
  if (qdrantUrl) {
    for (const w of listWikis()) {
      try {
        const resp = await fetch(`${qdrantUrl.replace(/\/+$/, "")}/collections/${collectionName(w.id)}`, {
          headers: c.env.QDRANT_API_KEY ? { "api-key": c.env.QDRANT_API_KEY } : {},
        })
        if (resp.ok) {
          const j = (await resp.json()) as { result?: { points_count?: number } }
          stats.set(w.id, { document_count: 0, chunk_count: j.result?.points_count ?? 0, last_updated: null })
        }
      } catch {
        // 单库统计失败忽略，该库保持归零
      }
    }
  }
  return c.json(buildCorporaResponse(stats))
})

// GET /api/v1/tree/:wiki_id —— 知识树（T2.4）：Qdrant scroll → buildTree 聚合。
api.get("/tree/:wiki_id", async (c) => {
  const wikiId = c.req.param("wiki_id")
  if (!isValidCorpus(wikiId)) {
    return c.json({ error: "invalid-corpus" }, 422)
  }
  if (!c.env.QDRANT_URL) {
    return c.json({ error: "qdrant-unconfigured" }, 502)
  }
  try {
    const chunks = await fetchAllChunks(collectionName(wikiId), c.env.QDRANT_URL, c.env.QDRANT_API_KEY, fetch)
    return c.json({ wiki_id: wikiId, tree: buildTree(chunks) })
  } catch (e) {
    if (e instanceof QdrantScrollError) {
      if (e.status === 404) return c.json({ error: "wiki-not-found" }, 404)
      return c.json({ error: "qdrant-unavailable" }, 502)
    }
    throw e
  }
})

// POST /api/v1/search —— 纯向量检索（T0.4）
api.post("/search", async (c) => {
  let body: Partial<SearchRequest> = {}
  try {
    body = await c.req.json<SearchRequest>()
  } catch {
    // 解析失败时 body 为空，走下方 runSearch 的 422 校验
  }
  try {
    // runSearch 内部完成全部参数校验，非法时抛 SearchValidationError → 422。
    const result = await runSearch(body as SearchRequest, c.env)
    return c.json(result)
  } catch (err) {
    if (err instanceof SearchValidationError) {
      return c.json({ error: err.code }, 422)
    }
    throw err
  }
})

// 其余 v1 路由：M0 统一登记为未实现占位，标注各自预期实现任务
api.post("/auth/oauth/:provider/callback", (c) => c.json({ error: "not-yet" }, 501)) // TODO(T3.1)
api.post("/auth/bind/email", (c) => c.json({ error: "not-yet" }, 501)) // TODO(T3.1)
api.post("/auth/bind/x", (c) => c.json({ error: "not-yet" }, 501)) // TODO(T3.1)
api.get("/me", (c) => c.json({ error: "not-yet" }, 501)) // TODO(T3.1/T3.2)
api.post("/search/stream", (c) => c.json({ error: "not-yet" }, 501)) // TODO(T3.4)
api.post("/chat", (c) => c.json({ error: "not-yet" }, 501)) // TODO(T3.4)
api.get("/admin/keys", (c) => c.json({ error: "not-yet" }, 501)) // TODO(M3 admin)
api.post("/admin/keys", (c) => c.json({ error: "not-yet" }, 501)) // TODO(M3 admin)

app.route("/api/v1", api)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx)
  },

  // ── Cron Trigger（T2.2）：UTC 01:00，对每个 wiki 发一条 Queue 消息（单 wiki 失败互不影响）──
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const jobs = listWikis().map((w) =>
      env.INGEST_QUEUE.send({ wikiId: w.id } as IngestMessage).catch(() => {
        console.error(`[ingest] 发送 Queue 消息失败 wiki=${w.id}`)
      }),
    )
    ctx.waitUntil(Promise.allSettled(jobs).then(() => undefined))
  },

  // ── Queue consumer（T2.2）：每消息一个 wikiId → 增量 ingest；单 wiki 失败记 ingest_runs error，不整体抛 ──
  async queue(batch: MessageBatch<IngestMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      const wikiId = msg.body?.wikiId
      if (!wikiId) {
        msg.retry()
        continue
      }
      ctx.waitUntil(
        ingestWiki(env, wikiId).catch((e) => {
          console.error(`[ingest] wiki=${wikiId} 失败: ${(e as Error)?.message ?? String(e)}`)
        }),
      )
    }
  },
}
