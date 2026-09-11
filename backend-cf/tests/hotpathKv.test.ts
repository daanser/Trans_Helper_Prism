// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 热路径 KV 操作守卫（性能优化第二轮：把 KV 从 /search 的响应路径上摘干净）
//
// 线上实测（/admin/d1bench）：KV put = **635–653ms**、未命中 get = 260–496ms、命中 get = 4ms。
// 而优化前一次 `/search` 的 KV 操作是：
//   · KV 限流器：account + ip **各 get + put**（4 次，其中 2 次 put ≈ 1.3s）
//   · 禁用集读取：3 次 get（Promise.all，wall ≈ 0.3–0.5s）
//   · 检索缓存：1 次 get + 1 次 put（put ≈ 0.65s，且省下的 embed 只有 ~0.5s）
// 本文件把"**响应路径上不得有 KV put，且不得再碰限流器的 `rl:*` 键**"锁死：
// 谁把 KV 限流器加回来、或把缓存写改回 await，这里就会红。
import { describe, it, expect, vi, afterEach } from "vitest"
import { app } from "../src/index"
import { issueSession } from "../src/auth"
import { withBatch } from "./d1MockBatch"
import type { Env } from "../src/types"

const JWT_SECRET = "k".repeat(64)
const PROXY_SECRET = "proxy-shared-secret"

/** 可数 KV：记录每次 get/put 的键；put 返回一个"由测试放行"的 promise，用于分辨 await 与 waitUntil。 */
function makeCountingKv() {
  const gets: string[] = []
  const puts: string[] = []
  let releasePuts: (() => void) | null = null
  const gate = new Promise<void>((r) => {
    releasePuts = r
  })
  const kv = {
    async get(key: string): Promise<string | null> {
      gets.push(key)
      return null // 一律未命中：强制走"读不到 → 现算 + 写缓存"的分支
    },
    async put(key: string, _value: string, _options?: { expirationTtl?: number }): Promise<void> {
      puts.push(key)
      await gate // 直到测试放行才 resolve：仍在 await 的话请求就会卡住
    },
  } as unknown as KVNamespace
  return { kv, gets, puts, release: () => releasePuts?.() }
}

/**
 * 语义正确的小 D1 mock（rate_counters 内存表 + 单行 quotas），并补上 batch（与生产同形状）。
 * 本文件的断言都在 KV 上，D1 只需要"让请求走通且配额视图正确"。
 */
function makeDb() {
  const rows = new Map<string, { count: number; window_start: number; window_sec: number }>()
  // 网格锚：注册于 3 小时前 → 当前 5h 窗口起点就是它自己（window = [anchor, anchor+5h) 含 now）
  const anchor = Date.now() - 3 * 3600_000
  const quota: { period_start: number; used_cost: number; monthly_limit: number } = {
    period_start: anchor,
    used_cost: 0,
    monthly_limit: 5,
  }
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
            const row = rows.get(String(args[0]))
            return row ? { count: row.count } : null
          }
          if (sql.includes("SELECT created_at FROM accounts")) return { created_at: anchor }
          if (sql.includes("FROM accounts WHERE id = ?")) {
            return { status: "active", created_at: 1, disclaimer_ack_at: null }
          }
          if (sql.includes("SELECT period_start")) return { ...quota }
          return null
        },
        async all() {
          return { success: true, results: [], meta: { changes: 0 } }
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO rate_counters")) {
            const key = String(args[0])
            if (!rows.has(key)) rows.set(key, { count: 0, window_start: Number(args[2]), window_sec: Number(args[3]) })
            return { success: true, results: [], meta: { changes: 1 } }
          }
          if (sql.includes("count = count + 1")) {
            const row = rows.get(String(args[1]))
            if (!row || row.count >= Number(args[2])) return { success: true, results: [], meta: { changes: 0 } }
            row.count += 1
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
  return withBatch(raw) as unknown as D1Database
}

function makeEnv(kv: KVNamespace): Env {
  return {
    DB: makeDb(),
    SEARCH_CACHE: kv,
    INGEST_QUEUE: undefined as never,
    JWT_SECRET,
    PROXY_SHARED_SECRET: PROXY_SECRET,
    REQUIRE_LOGIN: "0", // 匿名也走完整检索（fetch 由各用例 stub，零真实网络）
    EMBED_POOL_KEYS: "sk-test-embed", // 让 embed 阶段有 key 可用（网络由 stubVectorStage 拦下）
    QDRANT_URL: "https://qdrant.example",
    EMBEDDING_DIM: "1024",
  } as unknown as Env
}

const proxyHeaders = {
  "x-prism-proxy": PROXY_SECRET,
  "x-prism-client-ip": "203.0.113.7",
  "x-prism-country": "US",
  "x-prism-asn": "16509",
}

/** Worker 的 ExecutionContext mock：收集 waitUntil 的 promise（响应返回后由运行时继续跑）。 */
function makeCtx() {
  const deferred: Array<Promise<unknown>> = []
  return { deferred, ctx: { waitUntil: (p: Promise<unknown>) => deferred.push(p), passThroughOnException: () => {} } }
}

/**
 * 让向量阶段真正跑完的 fetch stub（embedding + Qdrant 各一次）。
 * 关键：**不能**让它失败 —— 失败会提前走关键词回退，根本到不了"写缓存"那一步。
 */
function stubVectorStage() {
  const stub = vi.fn(async (url: unknown): Promise<Response> => {
    const u = String(url)
    if (u.includes("/v1/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.1) }] }), { status: 200 })
    }
    if (u.includes("/points/search")) return new Response(JSON.stringify({ result: [] }), { status: 200 })
    return new Response(JSON.stringify({ error: "unexpected-url" }), { status: 500 })
  }) as unknown as typeof fetch
  vi.stubGlobal("fetch", stub)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function search(env: Env, init: { headers?: Record<string, string>; ctx?: unknown }) {
  const headers = { "Content-Type": "application/json", ...proxyHeaders, ...(init.headers ?? {}) }
  const body = JSON.stringify({ query: "激素", corpora: ["mtf-wiki"] })
  // Hono 的 app.request 第 4 参就是 ExecutionContext（Worker 里由运行时注入）
  return init.ctx
    ? app.request("/api/v1/search", { method: "POST", headers, body }, env, init.ctx as ExecutionContext)
    : app.request("/api/v1/search", { method: "POST", headers, body }, env)
}

describe("热路径 KV 守卫（/search 响应路径上不得有 KV put）", () => {
  it("有 executionCtx：缓存写交给 waitUntil —— 响应**不等** KV put，且热路径上再无 `rl:*`（限流器已摘除）", async () => {
    stubVectorStage()
    const { kv, gets, puts, release } = makeCountingKv()
    const env = makeEnv(kv)
    const { deferred, ctx } = makeCtx()

    const resp = await search(env, { ctx })
    expect(resp.status).toBe(200)
    await resp.json() // 拿到响应（此刻 put 还没被放行）

    // ① 热路径上没有**阻塞**的 KV put：put 已启动但被交给 waitUntil（deferred），响应没等它
    expect(puts).toHaveLength(1)
    expect(deferred.length).toBeGreaterThanOrEqual(1)
    // ② 键空间证明：热路径上**没有任何** `rl:*`（KV 限流器已摘除）；
    //    首次请求会读 3 个 `keydeny:*`（禁用集，之后走 30s 进程内缓存），这是唯一允许的非 vec 读。
    expect(puts.every((k) => k.startsWith("vec:"))).toBe(true)
    expect([...gets, ...puts].some((k) => k.startsWith("rl:"))).toBe(false)
    expect(gets.filter((k) => k.startsWith("keydeny:"))).toHaveLength(3)
    expect(gets.filter((k) => k.startsWith("vec:"))).toHaveLength(1) // 检索缓存读（未命中）

    release()
    await Promise.all(deferred) // 放行，避免悬空 promise
  })

  it("无 executionCtx（单测 / 非 Worker 调用）：回退为 await put，且依然不碰限流器键", async () => {
    stubVectorStage()
    const { kv, gets, puts, release } = makeCountingKv()
    const env = makeEnv(kv)

    let settled = false
    const p = Promise.resolve(search(env, {})).then((r) => {
      settled = true
      return r
    })
    for (let i = 0; i < 50 && puts.length === 0; i++) await new Promise((r) => setTimeout(r, 0))
    expect(puts).toHaveLength(1)
    expect(settled).toBe(false) // 卡在 put 上 → 说明是 await（回退语义，与优化前一致）
    release()
    const resp = await p
    expect(resp.status).toBe(200)
    expect(gets.some((k) => k.startsWith("rl:"))).toBe(false) // 依旧不碰限流器
    expect(puts.every((k) => k.startsWith("vec:"))).toBe(true)
  })

  it("禁用集第二次请求起 0 次 KV 读（进程内缓存生效）；此前最多 3 次 keydeny 读", async () => {
    stubVectorStage()
    const { kv, gets, release } = makeCountingKv()
    const env = makeEnv(kv)
    const { deferred, ctx } = makeCtx()

    await (await search(env, { ctx })).json()
    const denyReadsFirst = gets.filter((k) => k.startsWith("keydeny:")).length
    expect(denyReadsFirst).toBe(3) // embed / llm / rerank 三池

    gets.length = 0 // 只看第二次请求
    await (await search(env, { ctx })).json()
    expect(gets.filter((k) => k.startsWith("keydeny:")).length).toBe(0) // 命中缓存
    expect(gets).toEqual([expect.stringMatching(/^vec:/)]) // 只剩检索缓存那一次读（命中时 4ms，划算）

    release()
    await Promise.all(deferred)
  })

  it("登录态同样干净：/search 的响应路径 = 1 次 vec 读 + 0 次阻塞 put", async () => {
    stubVectorStage()
    const { kv, gets, puts, release } = makeCountingKv()
    const env = makeEnv(kv)
    const { deferred, ctx } = makeCtx()
    const token = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })

    const resp = await search(env, { headers: { Authorization: `Bearer ${token}` }, ctx })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { quota?: { used_pct?: number }; timings?: Record<string, number> }
    expect(body.quota?.used_pct).toBe(0.1) // 配额视图仍正确（来自扣费同事务回读）
    // 诊断字段保留（部署后用它们验收 gate_ms / handler_ms）
    expect(typeof body.timings?.gate_ms).toBe("number")
    expect(typeof body.timings?.handler_ms).toBe("number")
    expect(typeof body.timings?.gate_burst_ms).toBe("number")

    // 首次请求：3 次 keydeny 读（禁用集，之后 30s 内不再读）+ 1 次 vec 读（检索缓存）+ 1 次 vec put（交给 waitUntil）
    expect(gets.filter((k) => k.startsWith("keydeny:"))).toHaveLength(3)
    expect(gets.filter((k) => k.startsWith("vec:"))).toHaveLength(1)
    expect([...gets, ...puts].some((k) => k.startsWith("rl:"))).toBe(false) // 限流器键彻底消失
    expect(puts).toHaveLength(1)
    expect(puts.every((k) => k.startsWith("vec:"))).toBe(true)
    expect(deferred.length).toBeGreaterThanOrEqual(1)

    release()
    await Promise.all(deferred)
  })
})
