// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf Hono entry (GPL-3.0)
// 依据 plan.md §9.3 预留路由结构。已实现：/healthz、/api/v1/search（纯向量+rerank+缓存+熔断）、
// /api/v1/corpora（T2.1）、/api/v1/tree/:wiki_id（T2.4）、Queue consumer + Cron（T2.2 增量管线）。
// 其余路由登记为占位/未实现（返回 501 not-yet），待 M3 填充。
import { Hono } from "hono"
import type { Context } from "hono"
import { cors } from "hono/cors"
import { Env, SearchRequest, SearchResponse } from "./types"
import { runSearch, validate, SearchValidationError } from "./search"
import { listWikis, collectionName, isValidCorpus, buildCorporaResponse } from "./wiki_registry"
import { fetchAllChunks, buildTree, QdrantScrollError } from "./tree"
import { ingestWiki, type IngestMessage } from "./ingest/incremental"
import { backfillWikiUrls } from "./backfillUrls"
import {
  startXLogin,
  exchangeXCode,
  upsertXAccount,
  issueSession,
  sessionFromHeader,
  loginRedirectUrl,
  frontendBase,
  AuthConfigError,
} from "./auth"
import {
  chargeQuota,
  computeQuotaCost,
  formatPct,
  getQuota,
  grantQuota,
  resetQuota,
  toQuotaResponse,
} from "./quota"
import {
  checkSubjectRateLimit,
  clientIpFromHeaders,
  kvRateLimitStore,
  type RateLimitPolicy,
  rateLimitHeaders,
} from "./ratelimit"
import { listAudit, writeAudit } from "./audit"
import { SCHEMA_STATEMENTS } from "./db/schemaStatements"
import { runFallback, type FallbackResponse } from "./fallback"
import {
  buildPrompt,
  createChatProvider,
  isLlmUnavailable,
  LLM_UNAVAILABLE_NOTICE,
  type ChatMessage,
  type LlmHit,
  type LlmUsage,
} from "./llm"
import { appendRound, createSession, historyToMessages, isMaxRounds, loadContext } from "./chat"
import {
  callCustomModel,
  deleteCustomModel,
  listCustomModels,
  loadCustomModel,
  saveCustomModel,
} from "./custommodel"
import type { KeyPool, KeyPoolDb, UsageRecord } from "./keypool"
import {
  buildPoolInfos,
  fetchProviderKeyRows,
  isPoolName,
  isSafeKeyRef,
  kvDenyStore,
  poolRefsFromEnv,
  readDeniedPools,
  setKeyDenied,
  upsertProviderKey,
  type DeniedPools,
} from "./keyadmin"
import { buildAdminUsage } from "./adminstats"

/** Key Pool 记账适配：把用量写进 D1 key_usage（失败不影响业务）。 */
function makeKeyUsageDb(env: Env): KeyPoolDb {
  return {
    async recordUsage(rec: UsageRecord) {
      if (!env.DB) return
      try {
        await env.DB.prepare(
          `INSERT INTO key_usage (id, pool, key_ref, endpoint, model, status, status_code, tokens_in, tokens_out, latency_ms, cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            crypto.randomUUID(),
            rec.pool,
            rec.keyRef,
            rec.endpoint,
            rec.model ?? "",
            rec.status,
            rec.statusCode ?? null,
            rec.tokensIn ?? 0,
            rec.tokensOut ?? 0,
            rec.latencyMs ?? null,
            rec.cost ?? 0,
            Date.now(),
          )
          .run()
      } catch {
        // 记账失败不影响业务
      }
    },
  }
}

/** chat provider 单例（保留 key 冷却/剔除状态；多 isolate 各自独立，可接受）。 */
let chatProvider: ReturnType<typeof createChatProvider> | null = null
let chatProviderFp = ""
function getChatProvider(env: Env) {
  const fp = `${env.LLM_MODEL ?? ""}|${env.LLM_ENDPOINT ?? ""}|${(env.LLM_POOL_KEYS ?? "").length}`
  if (!chatProvider || chatProviderFp !== fp) {
    chatProvider = createChatProvider(env, makeKeyUsageDb(env))
    chatProviderFp = fp
  }
  return chatProvider
}

/**
 * T3.3 运行时效：读 KV 的「admin 下架 key」集合（fail-open）。
 * 读 KV / 解析 / 任何异常 → 空集合（视为无禁用），**绝不影响检索与 LLM**。
 */
async function loadDeniedKeys(env: Env): Promise<DeniedPools> {
  try {
    return await readDeniedPools(kvDenyStore(env.SEARCH_CACHE), env)
  } catch {
    return { embed: [], llm: [], rerank: [] }
  }
}

/** 把禁用集合热更新到 chat 单例的池上（每次请求刷一次，KV 变更即时生效）。 */
function applyDeniedToPool(pool: KeyPool, denied: DeniedPools, poolName: "llm" | "rerank"): void {
  try {
    pool.setDenied(poolName, denied[poolName])
  } catch {
    // 任何异常 → 不放禁用（fail-open）
  }
}

/** SearchHit → LLM 输入（截断由 llm.ts 内部负责）。 */
function toLlmHits(hits: SearchResponse["hits"]): LlmHit[] {
  return hits.map((h) => ({ id: h.id, title: h.title, url: h.url, source: h.source, text: h.snippet }))
}

/**
 * 限流策略（env 可调）。匿名放开向量检索后，IP 维度是唯一的成本闸门，故默认收紧到 20 次/分钟；
 * 登录账号 60 次/分钟（另有配额计量兜底）。
 */
function rateLimitPolicy(env: Env): RateLimitPolicy {
  const parse = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    account: { limit: parse(env.RATE_LIMIT_ACCOUNT_PER_MIN, 60), windowSec: 60 },
    ip: { limit: parse(env.RATE_LIMIT_IP_PER_MIN, 20), windowSec: 60 },
  }
}

/** 未登录是否强制只走关键词回退（plan §2 登录制；REQUIRE_LOGIN=0 可关闭）。 */
function requireLogin(env: Env): boolean {
  return (env.REQUIRE_LOGIN ?? "1") !== "0"
}

/** 统一的「关键词回退 + 原因 warning」响应。 */
function fallbackResponse(
  fb: FallbackResponse,
  quotaFields: { used_pct: number; remaining_pct: number },
  reason: string,
) {
  return {
    hits: fb.hits,
    timings: { embed_ms: 0, search_ms: 0, rerank_ms: 0, llm_ms: 0, total_ms: 0 },
    quota: { ...quotaFields, fallback: true },
    warnings: [reason],
    fallback: true as const,
    notice: fb.notice,
  }
}

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
// ── POST /search（T3.2/T3.3）：限流 → 登录判定 → 配额 → 检索 ──
api.post("/search", async (c) => {
  let body: Partial<SearchRequest> = {}
  try {
    body = await c.req.json<SearchRequest>()
  } catch {
    // 解析失败：交给 runSearch 的 422 校验
  }
  const req = body as SearchRequest
  const nowMs = Date.now()
  const corporaList = Array.isArray(req.corpora) ? req.corpora : []

  // ⓪ 参数校验先行：非法参数一律 422（不受登录/限流影响）
  try {
    validate(req)
  } catch (err) {
    if (err instanceof SearchValidationError) return c.json({ error: err.code }, 422)
    throw err
  }

  // ① 限流：未登录按 IP，登录按账号（KV 缺失 fail-open）
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  const ip = clientIpFromHeaders(c.req.raw.headers)
  const rl = await checkSubjectRateLimit(
    c.env.SEARCH_CACHE ? kvRateLimitStore(c.env.SEARCH_CACHE) : undefined,
    { ip, accountId: session?.sub },
    rateLimitPolicy(c.env),
    nowMs,
  )
  if (rl.degraded) console.warn(`[ratelimit] degraded scope=${rl.scope}`)
  if (!rl.allowed) {
    return c.json({ error: "rate-limited", retry_after: rl.retryAfterSec }, 429, rateLimitHeaders(rl))
  }

  // ② 未登录：按 plan §2 登录制只走关键词回退（REQUIRE_LOGIN=0 可放开）
  if (!session && requireLogin(c.env)) {
    const fb = await runFallback(req.query ?? "", corporaList, c.env)
    return c.json(fallbackResponse(fb, { used_pct: 0, remaining_pct: 100 }, "login-required"))
  }

  // ③ 登录：先扣配额（D1 原子），超额 → 回退且不扣
  if (session) {
    const cost = computeQuotaCost({ search: true, rerank: req.use_reranker !== false })
    const charge = await chargeQuota(c.env.DB, session.sub, cost, nowMs, c.env)
    if (!charge.ok && charge.reason === "quota-exceeded") {
      const fb = await runFallback(req.query ?? "", corporaList, c.env)
      return c.json(
        fallbackResponse(fb, { used_pct: charge.used_pct, remaining_pct: charge.remaining_pct }, "quota-exceeded"),
      )
    }
    if (!charge.ok) console.warn("[quota] db-unavailable → fail-open")
  }

  // ④ 检索（T3.3：先取 admin 下架集合，fail-open 传给工厂）
  try {
    const result = await runSearch(req, c.env, { denied: await loadDeniedKeys(c.env) })
    if (!session) return c.json(result)
    const view = await getQuota(c.env.DB, session.sub, nowMs, c.env)
    const fb = Boolean((result as SearchResponse).fallback)
    return c.json({ ...(result as SearchResponse), quota: toQuotaResponse(view, fb) })
  } catch (err) {
    if (err instanceof SearchValidationError) return c.json({ error: err.code }, 422)
    throw err
  }
})

// 其余 v1 路由：M0 统一登记为未实现占位，标注各自预期实现任务
// ── 登录（T3.1）：X OAuth 2.0 + PKCE ──
// GET /auth/oauth/x/start → 302 到 X 授权页（state/verifier 存 KV）
api.get("/auth/oauth/x/start", async (c) => {
  try {
    const { url } = await startXLogin(c.env, c.req.query("redirect"))
    return c.redirect(url, 302)
  } catch (e) {
    if (e instanceof AuthConfigError) return c.json({ error: (e as Error).message }, 503)
    return c.json({ error: "oauth-start-failed" }, 502)
  }
})

// GET /auth/oauth/x/callback → 换 token、取用户、建号、签 JWT，302 回前端（token 放 fragment）
api.get("/auth/oauth/x/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state")
  const fail = (reason: string) =>
    c.redirect(`${frontendBase(c.env)}/login/#error=${encodeURIComponent(reason)}`, 302)

  if (!code || !state) return fail("missing-code-or-state")
  if (!c.env.DB) return fail("db-unconfigured")

  try {
    const { xId, handle, redirectAfter } = await exchangeXCode(c.env, code, state)
    const acc = await upsertXAccount(c.env.DB, c.env, xId, handle, Date.now())
    if (acc.status === "banned") return fail("account-banned")
    const token = await issueSession(c.env, { sub: acc.account_id, handle: acc.handle, role: acc.role })
    return c.redirect(loginRedirectUrl(c.env, redirectAfter, token), 302)
  } catch (e) {
    // 不回显任何密钥/原始响应；只给泛化原因
    return fail((e as Error)?.message?.slice(0, 60) ?? "oauth-callback-failed")
  }
})

api.post("/auth/bind/email", (c) => c.json({ error: "not-yet" }, 501)) // 邮箱绑定已砍（T3.7 取消）

// GET /me → 当前账号 + 配额（需 Authorization: Bearer <JWT>）
api.get("/me", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const acc = await c.env.DB.prepare("SELECT status, created_at FROM accounts WHERE id = ?")
    .bind(session.sub)
    .first<{ status: string; created_at: number }>()
  if (!acc) return c.json({ error: "account-not-found" }, 404)
  if (acc.status !== "active") return c.json({ error: "account-" + acc.status }, 403)

  const quota = await getQuota(c.env.DB, session.sub, Date.now(), c.env)
  return c.json({
    // handle 来自会话 JWT（DB 不存 X 明文，见 auth.ts 隐私注释）
    user: { account_id: session.sub, handle: session.handle, role: session.role, created_at: acc.created_at },
    quota,
    quota_display: formatPct(quota.used_pct),
  })
})

// ── POST /search/stream（T3.4）：SSE 流式 AI 总结 ──
api.post("/search/stream", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)

  let body: Partial<SearchRequest> = {}
  try {
    body = await c.req.json<SearchRequest>()
  } catch {
    /* 交给 runSearch 校验 */
  }
  const req = body as SearchRequest
  const nowMs = Date.now()

  // 搜索部分先扣额度
  const cost = computeQuotaCost({ search: true, rerank: req.use_reranker !== false })
  const charge = await chargeQuota(c.env.DB, session.sub, cost, nowMs, c.env)
  if (!charge.ok && charge.reason === "quota-exceeded") {
    return c.json(
      { error: "quota-exceeded", quota: { used_pct: charge.used_pct, remaining_pct: charge.remaining_pct } },
      429,
    )
  }

  let result: SearchResponse
  // T3.3 运行时效：禁用集合只影响 KeyPool 选 key，不改检索语义（fail-open）
  const denied = await loadDeniedKeys(c.env)
  try {
    result = (await runSearch({ ...req, use_llm: false }, c.env, { denied })) as SearchResponse
  } catch (err) {
    if (err instanceof SearchValidationError) return c.json({ error: err.code }, 422)
    throw err
  }

  const question = (req.query ?? "").trim()
  const llmHits = toLlmHits(result.hits ?? [])
  const wantLlm = req.use_llm === true
  const enc = new TextEncoder()
  const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const view = await getQuota(c.env.DB, session.sub, nowMs, c.env)
        controller.enqueue(
          sse("hits", {
            hits: result.hits,
            timings: result.timings,
            quota: toQuotaResponse(view, Boolean(result.fallback)),
            fallback: result.fallback,
          }),
        )
        if (!wantLlm) {
          controller.enqueue(sse("done", { llm: false }))
          return
        }

        const ctx = await createSession(
          c.env.DB,
          session.sub,
          req.model_id ?? "default",
          Array.isArray(req.corpora) ? req.corpora : [],
          llmHits,
          Date.now(),
        )
        if (ctx) controller.enqueue(sse("session", { session_id: ctx.id, max_rounds: 10 }))

        const chat = getChatProvider(c.env)
        applyDeniedToPool(chat.pool, denied, "llm")
        const llm = chat.provider.streamSummary(llmHits, question)
        controller.enqueue(sse("citations", { citations: llm.citations, model: llm.model }))
        let text = ""
        for await (const delta of llm) {
          text += delta
          controller.enqueue(sse("delta", { text: delta }))
        }
        let usage: LlmUsage | null = null
        try {
          usage = await llm.usage
        } catch {
          /* 用量结算失败不阻断 */
        }
        if (ctx && text) await appendRound(c.env.DB, ctx.id, "assistant", text, Date.now())
        if (usage) {
          await chargeQuota(
            c.env.DB,
            session.sub,
            computeQuotaCost({ llmTokens: usage.tokens_in + usage.tokens_out }),
            Date.now(),
            c.env,
          )
        }
        controller.enqueue(sse("done", { llm: true, model: llm.model, usage }))
      } catch (e) {
        const code = isLlmUnavailable(e) ? e.code : "llm-upstream"
        controller.enqueue(sse("error", { code, notice: LLM_UNAVAILABLE_NOTICE }))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
})

// ── POST /chat（T3.4 多轮追问）──
api.post("/chat", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)

  let body: { session_id?: string; question?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    /* 下面 422 */
  }
  const sessionId = (body.session_id ?? "").trim()
  const question = (body.question ?? "").trim()
  if (!sessionId || !question) return c.json({ error: "session_id-and-question-required" }, 422)

  const ctx = await loadContext(c.env.DB, sessionId)
  if (!ctx) return c.json({ error: "session-not-found" }, 404)
  if (ctx.accountId !== session.sub) return c.json({ error: "forbidden" }, 403)
  if (isMaxRounds(ctx)) return c.json({ error: "max-rounds", notice: "已满 10 轮，请开新会话" }, 409)

  const appended = await appendRound(c.env.DB, sessionId, "user", question, Date.now())
  if (!appended.ok) return c.json({ error: appended.reason }, appended.reason === "max-rounds" ? 409 : 400)

  const history: ChatMessage[] = historyToMessages(ctx.history)
  try {
    if (ctx.modelId && ctx.modelId !== "default") {
      // T3.5：用户自带模型逃生通道
      const loaded = await loadCustomModel(c.env.DB, c.env, session.sub, ctx.modelId)
      if (!loaded.ok) return c.json({ error: loaded.code, reason: loaded.reason }, 502)
      const built = buildPrompt(ctx.initialHits, question, history)
      const out = await callCustomModel(loaded.config, built.messages)
      await appendRound(c.env.DB, sessionId, "assistant", out.text, Date.now())
      await chargeQuota(
        c.env.DB,
        session.sub,
        computeQuotaCost({ llmTokens: out.tokens_in + out.tokens_out }),
        Date.now(),
        c.env,
      )
      return c.json({
        text: out.text,
        citations: built.citations,
        model: out.model,
        tokens_in: out.tokens_in,
        tokens_out: out.tokens_out,
        estimated: out.estimated,
      })
    }

    const chat = getChatProvider(c.env)
    applyDeniedToPool(chat.pool, await loadDeniedKeys(c.env), "llm")
    const out = await chat.provider.summarize(ctx.initialHits, question, { history })
    await appendRound(c.env.DB, sessionId, "assistant", out.text, Date.now())
    await chargeQuota(
      c.env.DB,
      session.sub,
      computeQuotaCost({ llmTokens: out.tokens_in + out.tokens_out }),
      Date.now(),
      c.env,
    )
    return c.json({
      text: out.text,
      citations: out.citations,
      model: out.model,
      tokens_in: out.tokens_in,
      tokens_out: out.tokens_out,
      estimated: out.estimated,
    })
  } catch (e) {
    if (isLlmUnavailable(e)) {
      return c.json({ error: e.code, notice: LLM_UNAVAILABLE_NOTICE, hits: ctx.initialHits }, 503)
    }
    throw e
  }
})

// ── /settings/models（T3.5 自定义模型，仅本人）──
api.get("/settings/models", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  return c.json({ models: await listCustomModels(c.env.DB, session.sub) })
})

api.post("/settings/models", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  let body: { id?: string; name?: string; base_url?: string; model?: string; api_key?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid-body" }, 422)
  }
  const saved = await saveCustomModel(
    c.env.DB,
    c.env,
    session.sub,
    { name: body.name ?? "", base_url: body.base_url ?? "", model: body.model ?? "", api_key: body.api_key },
    Date.now(),
    body.id,
  )
  if (!saved.ok) {
    const status = saved.code === "db-unavailable" || saved.code === "enc-key-missing" ? 503 : 422
    return c.json({ error: saved.code, reason: saved.reason }, status)
  }
  return c.json({ model: saved.model })
})

// DELETE /settings/models/:id —— 删除本人自定义模型（越权/不存在 → 404）
api.delete("/settings/models/:id", async (c) => {
  const session = await sessionFromHeader(c.env, c.req.header("Authorization"))
  if (!session) return c.json({ error: "unauthorized" }, 401)
  const deleted = await deleteCustomModel(c.env.DB, session.sub, c.req.param("id"))
  if (!deleted.ok) {
    return c.json({ error: deleted.code, reason: deleted.reason }, deleted.code === "db-unavailable" ? 503 : 404)
  }
  return c.json({ ok: true, deleted: deleted.deleted })
})

/**
 * admin 路由统一鉴权（T3.3 + T3.6 扩展）：**二选一，任一通过即放行**
 *   ① `Authorization: Bearer <ADMIN_API_KEY>` —— 运维通道（curl / CI），行为与旧版完全一致；
 *   ② `Authorization: Bearer <JWT>` 且会话 `role === "admin"` —— 前端管理页通道
 *      （用 `sessionFromHeader()`，与 /me 同一套校验）。
 * 未通过 → 401 `{error:"unauthorized"}`（**不再**因为没有 ADMIN_API_KEY 就 503：
 * 只配了 JWT 的部署也必须能用管理页）。ADMIN_API_KEY 未配置 + JWT 非 admin → 同样 401。
 * 注意：这里不查账号封禁状态（JWT 已签名的 admin 视为可信；封禁的是「使用检索」而非「被审计」）。
 * 返回 `actorId`：审计用，`?actor=` 优先（旧运维习惯），其次 JWT 的 account_id，最后 "admin"。
 */
async function adminAuthorize(
  c: Context<{ Bindings: Env }>,
): Promise<{ denied: Response | null; actorId: string }> {
  const header = c.req.header("Authorization") ?? ""
  const actorParam = c.req.query("actor") ?? ""
  const key = c.env.ADMIN_API_KEY
  if (key && header === `Bearer ${key}`) {
    return { denied: null, actorId: actorParam || "admin" }
  }
  try {
    const session = await sessionFromHeader(c.env, header)
    if (session?.role === "admin") {
      return { denied: null, actorId: actorParam || session.sub }
    }
  } catch {
    // JWT 校验异常一律视为未通过（不 500、不回显任何细节）
  }
  return { denied: Response.json({ error: "unauthorized" }, { status: 401 }), actorId: "" }
}

// ── GET /admin/usage —— 只读用量总览（T3.3 / T3.6 /admin 页）──
//   数据：accounts + quotas（period_start=window_start、used_cost=used_tokens）+ provider_keys 脱敏投影。
//   额度/窗口长度来自 limitTokens(env)/windowHours(env)（见 src/quota.ts），不读 DB 的 monthly_limit。
//   绝不返回任何 secret：keys[] 只有 key_ref / 计数 / 成本（见 keyadmin.ts）。
api.get("/admin/usage", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)
  try {
    return c.json(await buildAdminUsage(c.env.DB, c.env, Date.now()))
  } catch {
    // 不把 SQL 细节回显给客户端；日志只留泛化信息。
    console.warn("[admin] usage aggregation failed")
    return c.json({ error: "db-unavailable" }, 503)
  }
})

// ── GET /admin/keys —— 只读 key 池健康（T3.3「keys 上架禁用 + 每 key 用量」）──
//   keys[]：provider_keys 行（**只有 key_ref**，绝无 secret）；pools[]：env 池的 ref 清单（parsePoolKeys 推导）。
//   D1 缺失 → 仍 200：pools 来自 env secrets，不依赖 D1（keys:[] / db_rows:0），运维仍能看到池配置。
api.get("/admin/keys", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  const pools = buildPoolInfos(c.env)
  if (!c.env.DB) return c.json({ keys: [], pools, db_rows: 0 })
  try {
    const keys = await fetchProviderKeyRows(c.env.DB)
    return c.json({ keys, pools, db_rows: keys.length })
  } catch {
    console.warn("[admin] provider_keys read failed")
    return c.json({ error: "db-unavailable" }, 503)
  }
})

// ── POST /admin/keys —— 上架/禁用一把 key（T3.3）──
//   ① provider_keys upsert（enabled）；② 写审计（action=key_enable|key_disable，target 只放 key_ref）；
//   ③ 运行时效：KV `keydeny:<pool>` 记录禁用集合，KeyPool 取用时剔除（KV 故障 = fail-open，不阻断）。
//   请求体 `{ key_ref: "llm-key-0", pool: "llm", enabled: false }`（enabled 缺省 = true 上架）。
api.post("/admin/keys", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied

  let body: { key_ref?: unknown; pool?: unknown; enabled?: unknown } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid-body" }, 422)
  }
  const keyRef = typeof body.key_ref === "string" ? body.key_ref.trim() : ""
  const poolRaw = typeof body.pool === "string" ? body.pool.trim() : ""
  // 形状校验：只接受 `<pool>-key-<n>`，真 key（sk-…）无法进来（见 keyadmin.isSafeKeyRef）
  if (!isSafeKeyRef(keyRef)) return c.json({ error: "invalid-key-ref" }, 422)
  if (!isPoolName(poolRaw)) return c.json({ error: "invalid-pool" }, 422)
  const pool = poolRaw
  const enabled = body.enabled !== false

  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)
  const nowMs = Date.now()
  try {
    await upsertProviderKey(c.env.DB, { pool, keyRef, enabled, nowMs })
  } catch {
    console.warn("[admin] provider_keys upsert failed")
    return c.json({ error: "db-unavailable" }, 503)
  }

  // 审计（旁路；失败不阻断 —— writeAudit 自身也不抛错）。target 只放 key_ref，绝不放真 key。
  const auditWritten = await writeAudit(c.env.DB, {
    actorId: auth.actorId,
    action: enabled ? "key_enable" : "key_disable",
    target: keyRef,
    detail: `pool=${pool}`,
    nowMs,
  })

  // 运行时效（fail-open）：KV 缺失/读写失败 → runtime_applied:false，请求仍 200。
  const runtime = await setKeyDenied(kvDenyStore(c.env.SEARCH_CACHE), pool, keyRef, enabled)
  const configured = poolRefsFromEnv(c.env, pool).includes(keyRef)
  return c.json({
    ok: true,
    key_ref: keyRef,
    pool,
    enabled,
    /** 该 ref 是否真在 env 池里配置（false = 预登记/疑似笔误；不阻断，避免先禁后配的死锁） */
    configured,
    /** KV 里的禁用集合（写入后的真值；KV 不可用时为空数组） */
    disabled_refs: runtime.refs,
    /** 运行时效是否生效（KV 不可用/写失败 → false，此时只有 DB 记了禁用） */
    runtime_applied: runtime.ok,
    audit_written: auditWritten,
  })
})

// POST /admin/accounts/:id/ban —— 封禁/解封（?unban=1 解封）
api.post("/admin/accounts/:id/ban", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const target = c.req.param("id")
  const actorId = auth.actorId
  const reason = c.req.query("reason") ?? "admin-ban"
  const banned = c.req.query("unban") !== "1"
  await c.env.DB.prepare("UPDATE accounts SET status = ? WHERE id = ?")
    .bind(banned ? "banned" : "active", target)
    .run()
  await writeAudit(c.env.DB, {
    actorId,
    action: banned ? "ban" : "unban",
    target,
    detail: `reason=${reason}`,
    nowMs: Date.now(),
  })
  return c.json({ ok: true, status: banned ? "banned" : "active" })
})

// POST /admin/accounts/:id/quota —— 加额/扣额/重置当前窗口
api.post("/admin/accounts/:id/quota", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const target = c.req.param("id")
  const actorId = auth.actorId
  const nowMs = Date.now()
  let body: { delta_tokens?: number; reset?: boolean } = {}
  try {
    body = await c.req.json()
  } catch {
    /* 默认按 0 处理 */
  }

  if (body.reset) {
    const view = await resetQuota(c.env.DB, target, nowMs, c.env)
    if (!view) return c.json({ error: "db-unavailable" }, 503)
    await writeAudit(c.env.DB, { actorId, action: "reset_quota", target, detail: "reset-current-window", nowMs })
    return c.json({ ok: true, quota: view, quota_display: formatPct(view.used_pct) })
  }

  const delta = Number.isFinite(body.delta_tokens) ? Number(body.delta_tokens) : 0
  const view = await grantQuota(c.env.DB, target, delta, nowMs, c.env)
  if (!view) return c.json({ error: "db-unavailable" }, 503)
  await writeAudit(c.env.DB, {
    actorId,
    action: delta >= 0 ? "grant_quota" : "revoke_quota",
    target,
    detail: `delta_tokens=${delta}`,
    nowMs,
  })
  return c.json({ ok: true, quota: view, quota_display: formatPct(view.used_pct) })
})

// POST /admin/db/apply-schema —— 幂等应用 D1 schema
// 用途：受限环境（wrangler d1 execute 不可用）下，用 Worker 的 D1 binding 完成建表/迁移。
// 安全性：只执行 src/db/schemaStatements.ts 中固定的 IF NOT EXISTS 语句，不接受任意 SQL；
//         鉴权同其它 admin 路由（ADMIN_API_KEY 或 JWT role=admin）。
api.post("/admin/db/apply-schema", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  if (!c.env.DB) return c.json({ error: "db-unconfigured" }, 503)

  const applied: string[] = []
  const failed: Array<{ stmt: string; error: string }> = []
  for (const stmt of SCHEMA_STATEMENTS) {
    try {
      await c.env.DB.prepare(stmt).run()
      applied.push(stmt.slice(0, 60))
    } catch (e) {
      failed.push({ stmt: stmt.slice(0, 60), error: (e as Error)?.message?.slice(0, 200) ?? "failed" })
    }
  }
  await writeAudit(c.env.DB, {
    actorId: auth.actorId,
    action: "apply_schema",
    detail: `applied=${applied.length} failed=${failed.length}`,
    nowMs: Date.now(),
  })
  return c.json(
    { ok: failed.length === 0, applied: applied.length, total: SCHEMA_STATEMENTS.length, failed },
    failed.length === 0 ? 200 : 207,
  )
})

// GET /admin/audit —— 审计日志
api.get("/admin/audit", async (c) => {
  const auth = await adminAuthorize(c)
  if (auth.denied) return auth.denied
  const rows = await listAudit(c.env.DB, {
    limit: Number(c.req.query("limit") ?? 50),
    offset: Number(c.req.query("offset") ?? 0),
  })
  return c.json({ rows })
})

// POST /api/v1/admin/ingest/trigger —— 手动触发 ingest（T2.2 运维入口，受 ADMIN_API_KEY 保护）
//   query:  wiki_id=<id>  可选，只触发单个 wiki；缺省触发全部注册 wiki。
//           reset=1       可选，先清 D1 的 ingest 状态（ingest_runs 成功 commit + ingest_files hash），
//                         强制下次 ingest 全量重嵌（用于重刷 url / 重建向量）。危险，需 ADMIN_API_KEY。
//   header:  Authorization: Bearer <ADMIN_API_KEY>
// 返回：每个目标 wiki 的 Queue 投递结果（实际 ingest 在后台 queue consumer 异步执行）。
api.post("/admin/ingest/trigger", async (c) => {
  const key = c.env.ADMIN_API_KEY
  if (!key) return c.json({ error: "admin-key-unconfigured" }, 503)
  const auth = c.req.header("Authorization") ?? ""
  if (auth !== `Bearer ${key}`) return c.json({ error: "unauthorized" }, 401)

  const wikiId = c.req.query("wiki_id")
  const reset = c.req.query("reset") === "1"
  const targets = wikiId ? (isValidCorpus(wikiId) ? [wikiId] : []) : listWikis().map((w) => w.id)
  if (targets.length === 0) return c.json({ error: wikiId ? "invalid-corpus" : "no-wikis" }, 422)

  // reset=1：清 D1 的 ingest 状态，强制全量重嵌。逐个 try，避免一个失败阻断全部。
  const resetResults: Record<string, string> = {}
  if (reset && c.env.DB) {
    for (const id of targets) {
      try {
        await c.env.DB.prepare("DELETE FROM ingest_runs WHERE wiki_id = ?").bind(id).run()
        await c.env.DB.prepare("DELETE FROM ingest_files WHERE wiki_id = ?").bind(id).run()
        resetResults[id] = "ok"
      } catch (e) {
        resetResults[id] = `error:${(e as Error)?.message ?? "db-failed"}`
      }
    }
  } else if (reset && !c.env.DB) {
    return c.json({ error: "db-unavailable-for-reset" }, 503)
  }

  // 发 Queue 消息（与实际 scheduled 完全一致：后台 queue consumer 异步 ingest）。
  const sent: string[] = []
  const failed: string[] = []
  for (const id of targets) {
    try {
      await c.env.INGEST_QUEUE.send({ wikiId: id } as IngestMessage)
      sent.push(id)
    } catch {
      failed.push(id)
    }
  }
  return c.json({ reset: reset ? resetResults : undefined, sent, failed }, failed.length === 0 ? 200 : 503)
})

// POST /api/v1/admin/backfill-urls —— 存量数据 url 回填（只改 Qdrant payload，不重新 embed）
//   query:  wiki_id=<id>   必填
//           offset=<scroll offset>  可选，续跑上一页返回的 next_offset
//           page_size=<n>           可选，单页点数（默认 100，上限 500）
//   header: Authorization: Bearer <ADMIN_API_KEY>
// 免费版单次子请求上限 50，故按页处理：返回 { ..., next_offset, done }，done=false 时带 next_offset 续跑。
api.post("/admin/backfill-urls", async (c) => {
  const key = c.env.ADMIN_API_KEY
  if (!key) return c.json({ error: "admin-key-unconfigured" }, 503)
  if ((c.req.header("Authorization") ?? "") !== `Bearer ${key}`) return c.json({ error: "unauthorized" }, 401)

  const wikiId = c.req.query("wiki_id")
  if (!wikiId) return c.json({ error: "wiki_id-required" }, 422)
  if (!isValidCorpus(wikiId)) return c.json({ error: "invalid-corpus" }, 422)

  const offsetRaw = c.req.query("offset")
  const pageRaw = c.req.query("page_size")
  const pageSize = pageRaw ? parseInt(pageRaw, 10) : undefined

  try {
    const result = await backfillWikiUrls(c.env, wikiId, {
      offset: offsetRaw,
      pageSize: Number.isFinite(pageSize as number) ? pageSize : undefined,
    })
    return c.json(result)
  } catch (e) {
    const msg = (e as Error)?.message ?? "backfill-failed"
    // 不回显 key；只回泛化原因（unknown-wiki / qdrant-unconfigured / qdrant-*）。
    return c.json({ error: msg.slice(0, 200) }, 502)
  }
})

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
