// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — /search 路由级：匿名夹取 + 真实扣费差值 + 过采样落地（plan-topk.md §5 验收 2/3/4）
// 全 mock（D1 内存表 + fetch stub），零网络。扣费断言用 **mock 里 quotas 行的 used_cost 真实差值**，
// 不是"看百分比"——这样能精确验证 200 / 400 / 627 这些数字。
import { describe, it, expect, vi, afterEach } from "vitest"
import { app } from "../src/index"
import { issueSession } from "../src/auth"
import { withBatch } from "./d1MockBatch"
import type { Env, SearchResponse } from "../src/types"

const JWT_SECRET = "t".repeat(64)
const PROXY_SECRET = "proxy-shared-secret"

/** 极简 D1：rate_counters 内存表 + quotas 单行（used_cost 可读，用于算扣费差值）。 */
function makeDb(seedUsed = 0) {
  const anchor = Date.now() - 3 * 3600_000 // 5h 窗口起点（= 注册时刻）
  const counters = new Map<string, number>()
  const quota = { period_start: anchor, used_cost: seedUsed, monthly_limit: 5 }
  const raw = {
    prepare(sql: string) {
      let args: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) {
          args = a
          return stmt
        },
        async first() {
          if (sql.includes("SELECT count FROM rate_counters")) {
            const v = counters.get(String(args[0]))
            return v === undefined ? null : { count: v }
          }
          if (sql.includes("SELECT created_at FROM accounts")) return { created_at: anchor }
          if (sql.includes("FROM accounts WHERE id = ?")) return { status: "active", created_at: anchor, disclaimer_ack_at: null }
          if (sql.includes("SELECT period_start")) return { ...quota }
          return null
        },
        async all() {
          return { success: true, results: [], meta: { changes: 0 } }
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO rate_counters")) {
            const k = String(args[0])
            if (!counters.has(k)) counters.set(k, 0)
            return { success: true, results: [], meta: { changes: 1 } }
          }
          if (sql.includes("count = count + 1")) {
            const k = String(args[1])
            const cur = counters.get(k) ?? 0
            if (cur >= Number(args[2])) return { success: true, results: [], meta: { changes: 0 } }
            counters.set(k, cur + 1)
            return { success: true, results: [], meta: { changes: 1 } }
          }
          if (sql.includes("used_cost = used_cost + ?")) {
            const [cost, , , guard, limit] = args as [number, unknown, unknown, number, number]
            if (guard !== cost) throw new Error("guard-arg-mismatch")
            if (quota.used_cost + cost > limit) return { success: true, results: [], meta: { changes: 0 } }
            quota.used_cost += cost
            return { success: true, results: [], meta: { changes: 1 } }
          }
          return { success: true, results: [], meta: { changes: 1 } }
        },
      }
      return stmt
    },
  }
  return { db: withBatch(raw) as unknown as D1Database, quota }
}

/** fetch stub：embed + Qdrant（返回 hits 条候选）+ rerank（记录每次 HTTP 的文档数）。 */
function stubUpstream(hitCount = 80) {
  const rerankBatches: number[] = []
  let qdrantLimit = 0
  const stub = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u.includes("/v1/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.1) }] }), { status: 200 })
    }
    if (u.includes("/v1/rerank")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] }
      rerankBatches.push(body.documents.length)
      return new Response(
        JSON.stringify({ results: body.documents.map((_, i) => ({ index: i, relevance_score: 1 - i * 0.01 })) }),
        { status: 200 },
      )
    }
    if (u.includes("/points/search")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { limit?: number }
      qdrantLimit = Math.max(qdrantLimit, Number(body.limit ?? 0))
      const points = Array.from({ length: hitCount }, (_, i) => ({
        id: `p${i}`,
        score: 1 - i * 0.001,
        payload: { path: `path/${i}`, title: `T${i}`, text: `snippet ${i}`, url: `https://x/${i}`, wiki_id: "mtf-wiki" },
      }))
      return new Response(JSON.stringify({ result: points }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
  vi.stubGlobal("fetch", stub)
  return { rerankBatches, qdrantLimit: () => qdrantLimit }
}

afterEach(() => vi.unstubAllGlobals())

function makeEnv(db: D1Database, over: Partial<Env> = {}): Env {
  return {
    DB: db,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    JWT_SECRET,
    PROXY_SHARED_SECRET: PROXY_SECRET,
    EMBED_POOL_KEYS: "sk-embed-a",
    LLM_POOL_KEYS: "sk-llm-a", // rerank 并入 llm_pool
    QDRANT_URL: "https://qdrant.example",
    EMBEDDING_DIM: "1024",
    REQUIRE_LOGIN: "0", // 匿名也走完整检索（本文件要测匿名夹取对**实际检索**的影响）
    ...over,
  } as unknown as Env
}

const proxyHeaders = {
  "x-prism-proxy": PROXY_SECRET,
  "x-prism-client-ip": "203.0.113.7",
  "x-prism-country": "US",
  "x-prism-asn": "16509",
}

function search(env: Env, body: Record<string, unknown>, token?: string) {
  return app.request(
    "/api/v1/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...proxyHeaders,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query: "激素", corpora: ["mtf-wiki"], ...body }),
    },
    env,
  )
}

describe("匿名夹取（plan-topk.md §5 验收 2）", () => {
  it("匿名 top_k=50 → 200（**不报错**）、实际 ≤5 条、warnings 含 top-k-clamped-anon", async () => {
    stubUpstream()
    const { db } = makeDb()
    const resp = await search(makeEnv(db), { top_k: 50, use_reranker: false })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as SearchResponse
    expect(body.hits.length).toBeLessThanOrEqual(5)
    expect(body.warnings).toContain("top-k-clamped-anon")
  })

  it("匿名 top_k=3 → 不夹取、无该 warning；请求多少就最多给多少", async () => {
    stubUpstream()
    const { db } = makeDb()
    const body = (await (await search(makeEnv(db), { top_k: 3, use_reranker: false })).json()) as SearchResponse
    expect(body.hits.length).toBe(3)
    expect(body.warnings).not.toContain("top-k-clamped-anon")
  })

  it("匿名不传 top_k（默认 10）→ 也按 5 条夹取（默认值同样受匿名上限约束）", async () => {
    stubUpstream()
    const { db } = makeDb()
    const body = (await (await search(makeEnv(db), { use_reranker: false })).json()) as SearchResponse
    expect(body.hits.length).toBe(5)
    expect(body.warnings).toContain("top-k-clamped-anon")
  })

  it("登录用户同样请求可拿 50 条、且无夹取 warning", async () => {
    stubUpstream()
    const { db } = makeDb()
    const env = makeEnv(db)
    const token = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
    const body = (await (await search(env, { top_k: 50, use_reranker: false }, token)).json()) as SearchResponse
    expect(body.hits.length).toBe(50)
    expect(body.warnings).not.toContain("top-k-clamped-anon")
  })

  it("夹取发生在**检索之前**：匿名 n=50 的 rerank 候选数按 5 条算（不是 50）", async () => {
    const { rerankBatches } = stubUpstream()
    const { db } = makeDb()
    const env = makeEnv(db)
    const token = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })

    await (await search(env, { top_k: 50, use_reranker: true })).json() // 匿名 → 夹到 5 → 候选 15
    expect(rerankBatches).toEqual([15])

    rerankBatches.length = 0
    await (await search(env, { top_k: 20, use_reranker: true }, token)).json() // 登录 → 候选 60 → 2 批
    expect(rerankBatches).toEqual([32, 28]) // 每批 32：60 = 32 + 28
    expect(rerankBatches.reduce((a, b) => a + b, 0)).toBe(60)
  })
})

describe("扣费差值 = 预期总成本（plan-topk.md §5 验收 3）", () => {
  it("纯搜索：n=1 / 10 / 50 都是 200（与 n 无关）", async () => {
    stubUpstream()
    const { db, quota } = makeDb()
    const env = makeEnv(db)
    const token = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
    for (const n of [1, 10, 50]) {
      const before = quota.used_cost
      await (await search(env, { top_k: n, use_reranker: false }, token)).json()
      expect(quota.used_cost - before, `n=${n}`).toBe(200)
    }
  })

  it("开 rerank：n=10 → 400；n=20 → 600；n=50 → 627（候选封顶 64）；n=1 → 220", async () => {
    stubUpstream()
    const { db, quota } = makeDb()
    const env = makeEnv(db)
    const token = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
    const expectCost: Array<[number, number]> = [
      [1, 220],
      [10, 400],
      [20, 600],
      [50, 627],
    ]
    for (const [n, cost] of expectCost) {
      const before = quota.used_cost
      await (await search(env, { top_k: n, use_reranker: true }, token)).json()
      expect(quota.used_cost - before, `n=${n} 开 rerank`).toBe(cost)
    }
  })

  it("env 改过采样/上限时，扣费跟着变（与候选数同步）", async () => {
    stubUpstream()
    const { db, quota } = makeDb()
    const env = makeEnv(db, { RERANK_OVERFETCH: "2", RERANK_MAX_CANDIDATES: "40" })
    const token = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
    const before = quota.used_cost
    await (await search(env, { top_k: 10, use_reranker: true }, token)).json()
    // 2× → 候选 20 → rerank 成本 ceil(200×20/30)=134 → 总 334
    expect(quota.used_cost - before).toBe(334)
  })
})
