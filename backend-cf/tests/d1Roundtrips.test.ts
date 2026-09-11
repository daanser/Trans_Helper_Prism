// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — D1 往返次数验收测试（性能优化：把 /search 的 D1 往返从 ~15 压到 ≤5）
//
// 为什么要有这个文件：线上实测 /search TTFB 3.6–5.4s，而检索管线自报只有 ~1.2s ——
// 差的 3.5–4.5s 全是**顺序 D1 往返**（单次 0.1–0.2s，且不在 timings 里）。
// 本文件用「可数的 D1 mock」把往返次数**锁死**：
//   · `prepare()` 出来的语句**每次终止调用**（first/run/all）= 1 次往返；
//   · `batch([...])` = **1 次往返**（无论里面几条语句 —— 这正是优化的手段）。
// 谁把优化改回去（拆成一次一条），这里就会红。
//
// 覆盖面：匿名 /search（只走限流闸门）、登录 /search（闸门 + 配额）、/search/stream、/chat。
// mock 是**严格**的：遇到未识别的 SQL 直接抛错（防止实现漂移后静默通过），并在抛错信息里带上计数。
import { describe, it, expect } from "vitest"
import { app } from "../src/index"
import { issueSession } from "../src/auth"
import type { Env } from "../src/types"

const JWT_SECRET = "r".repeat(64)
const SECRET = "proxy-shared-secret"
const NOW_MS = Date.UTC(2026, 8, 11, 12, 0, 0)

interface Stats {
  /** D1 往返次数（batch 记 1 次，单条终止调用记 1 次） */
  roundtrips: number
  /** 执行过的语句数（诊断用：往返少了但语句数不该暴涨） */
  statements: number
  /** 写语句数（INSERT/UPDATE/DELETE） */
  writes: number
  /** 真实**受影响行数**之和（D1 计费按行，不按语句）——用于证明"往返少了但写放大没变" */
  rowsChanged: number
  sqls: string[]
}

/**
 * 可数 D1 mock：实现四条热路径真正会碰到的表（rate_counters / quotas / accounts / chat_sessions），
 * 每条 SQL 都按形状识别。未识别的 SQL → 抛错（带 SQL 片段与前缀计数，便于定位）。
 */
function makeCountingDb(seed: { accountId: string; createdAt: number } = { accountId: "acc-1", createdAt: NOW_MS - 3 * 3600_000 }) {
  const stats: Stats = { roundtrips: 0, statements: 0, writes: 0, rowsChanged: 0, sqls: [] }
  const rate = new Map<string, { bucket_key: string; tier: string; window_start: number; window_sec: number; count: number; updated_at: number }>()
  const quota = new Map<string, { period_start: number; used_cost: number; requests: number; monthly_limit: number; updated_at: number }>()
  const chat = new Map<string, Record<string, unknown>>()
  const accounts = new Map<string, { created_at: number; status: string }>([[seed.accountId, { created_at: seed.createdAt, status: "active" }]])

  /** 单条语句的执行（写 → changes；读 → 行）。返回 D1Result 形状。 */
  function exec(sql: string, args: unknown[]): { success: true; results: unknown[]; meta: { changes: number } } {
    stats.statements++
    const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)
    if (isWrite) stats.writes++
    const before = stats.rowsChanged
    const done = (res: { success: true; results: unknown[]; meta: { changes: number } }) => {
      stats.rowsChanged = before + (res.meta.changes ?? 0)
      return res
    }

    // ── rate_counters ──
    if (sql.includes("INSERT OR IGNORE INTO rate_counters")) {
      const [key, tier, start, sec, a5, a6] = args as [string, string, number, number, number, number?]
      if (rate.has(key)) return done({ success: true, results: [], meta: { changes: 0 } })
      // 两条 INSERT 形状：consume 版 `(?, ?, ?, ?, 0, ?)` = 5 参（count 写死 0）；
      // block 版 `(?, ?, ?, ?, ?, ?)` = 6 参（count 借用存 block_until）
      const isBlock = args.length === 6
      const count = isBlock ? Number(a5) : 0
      const updatedAt = isBlock ? Number(a6) : Number(a5)
      rate.set(key, { bucket_key: key, tier, window_start: start, window_sec: sec, count, updated_at: updatedAt })
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.includes("SET count = count + 1") && sql.includes("AND count < ?")) {
      const [updatedAt, key, limit] = args as [number, string, number]
      const row = rate.get(key)
      if (!row || row.count >= limit) return done({ success: true, results: [], meta: { changes: 0 } })
      row.count += 1
      row.updated_at = updatedAt
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.startsWith("UPDATE rate_counters SET count = ?")) {
      const [count, start, sec, updatedAt, key] = args as [number, number, number, number, string]
      const row = rate.get(key)
      if (!row) return done({ success: true, results: [], meta: { changes: 0 } })
      Object.assign(row, { count, window_start: start, window_sec: sec, updated_at: updatedAt })
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.includes("SELECT count FROM rate_counters")) {
      const row = rate.get(String(args[0]))
      return done({ success: true, results: row ? [{ count: row.count }] : [], meta: { changes: 0 } })
    }
    if (sql.startsWith("DELETE FROM rate_counters")) {
      const [threshold, batch] = args as [number, number]
      const victims = [...rate.values()].filter((r) => r.window_start < threshold).slice(0, batch)
      for (const v of victims) rate.delete(v.bucket_key)
      return done({ success: true, results: [], meta: { changes: victims.length } })
    }

    // ── quotas ──
    if (sql.includes("SELECT period_start, used_cost, monthly_limit FROM quotas")) {
      const row = quota.get(String(args[0]))
      return done({ success: true, results: row ? [{ period_start: row.period_start, used_cost: row.used_cost, monthly_limit: row.monthly_limit }] : [], meta: { changes: 0 } })
    }
    if (sql.includes("INSERT OR IGNORE INTO quotas")) {
      const [id, start, legacy, updatedAt] = args as [string, number, number, number]
      if (quota.has(id)) return done({ success: true, results: [], meta: { changes: 0 } })
      quota.set(id, { period_start: start, used_cost: 0, requests: 0, monthly_limit: legacy, updated_at: updatedAt })
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.includes("SET requests = 0") && sql.includes("AND period_start < ?")) {
      const [id, threshold] = args as [string, number]
      const row = quota.get(id)
      if (!row || !(row.period_start < threshold)) return done({ success: true, results: [], meta: { changes: 0 } })
      row.requests = 0
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.includes("used_cost = 0") && sql.includes("AND period_start < ?")) {
      const [start, updatedAt, id, threshold] = args as [number, number, string, number]
      const row = quota.get(id)
      if (!row || !(row.period_start < threshold)) return done({ success: true, results: [], meta: { changes: 0 } })
      Object.assign(row, { used_cost: 0, requests: 0, period_start: start, updated_at: updatedAt })
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.includes("AND period_start > ? AND period_start < ?")) {
      const [start, updatedAt, id, lower, upper] = args as [number, number, string, number, number]
      const row = quota.get(id)
      if (!row || !(row.period_start > lower) || !(row.period_start < upper)) return done({ success: true, results: [], meta: { changes: 0 } })
      Object.assign(row, { period_start: start, updated_at: updatedAt })
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.includes("used_cost = used_cost + ?")) {
      const [cost, updatedAt, id, guard, limit] = args as [number, number, string, number, number]
      if (guard !== cost) throw new Error("guard-arg-mismatch")
      const row = quota.get(id)
      if (!row || row.used_cost + cost > limit) return done({ success: true, results: [], meta: { changes: 0 } })
      row.used_cost += cost
      row.updated_at = updatedAt
      if (sql.includes("requests = requests + 1")) row.requests += 1
      return done({ success: true, results: [], meta: { changes: 1 } })
    }

    // ── accounts ──
    if (sql.includes("SELECT created_at FROM accounts")) {
      const row = accounts.get(String(args[0]))
      return done({ success: true, results: row ? [{ created_at: row.created_at }] : [], meta: { changes: 0 } })
    }
    if (sql.includes("FROM accounts WHERE id = ?")) {
      const row = accounts.get(String(args[0]))
      return {
        success: true,
        results: row ? [{ status: row.status, created_at: row.created_at, disclaimer_ack_at: null }] : [],
        meta: { changes: 0 },
      }
    }

    // ── chat_sessions（/chat、/search/stream 自身的会话 I/O，不计入本次优化目标）──
    if (sql.includes("FROM chat_sessions WHERE id = ?")) {
      const row = chat.get(String(args[0]))
      return done({ success: true, results: row ? [row] : [], meta: { changes: 0 } })
    }
    if (sql.startsWith("INSERT INTO chat_sessions")) {
      const [id] = args as [string]
      chat.set(id, {
        id,
        account_id: args[1],
        model_id: args[2],
        corpora: args[3],
        round_count: 0,
        initial_hits: args[4],
        history: "[]",
        created_at: args[5],
        updated_at: args[5],
      })
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.startsWith("UPDATE chat_sessions")) {
      const [roundCount, history, updatedAt, id] = args as [number, string, number, string]
      const row = chat.get(id)
      if (!row) return done({ success: true, results: [], meta: { changes: 0 } })
      Object.assign(row, { round_count: roundCount, history, updated_at: updatedAt })
      return done({ success: true, results: [], meta: { changes: 1 } })
    }
    if (sql.startsWith("INSERT INTO key_usage")) return done({ success: true, results: [], meta: { changes: 1 } })
    if (sql.startsWith("INSERT INTO audit_log")) return done({ success: true, results: [], meta: { changes: 1 } })

    throw new Error(`unhandled-sql(roundtrips=${stats.roundtrips}): ${sql.slice(0, 90)}`)
  }

  const db = {
    prepare(sql: string) {
      stats.sqls.push(sql)
      let bound: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) {
          bound = args
          return stmt
        },
        async first() {
          stats.roundtrips++
          const res = exec(sql, bound)
          return (res.results[0] as never) ?? null
        },
        async all() {
          stats.roundtrips++
          return exec(sql, bound) as never
        },
        async run() {
          stats.roundtrips++
          return exec(sql, bound) as never
        },
        // batch 需要能看穿每条语句（真实 D1 由运行时提供，这里手工实现）
        __sql: sql,
        __args: () => bound,
        __exec: () => exec(sql, bound),
      }
      return stmt
    },
    /** D1 batch：**一次往返**执行多条语句（隐式事务，按序返回结果）。 */
    async batch(stmts: Array<{ __exec: () => unknown }>) {
      stats.roundtrips++ // ← 关键：整批只算 1 次往返
      return stmts.map((s) => s.__exec()) as never
    },
  } as unknown as D1Database

  return { db, stats, rate, quota, chat }
}

function makeEnv(db: D1Database, over: Partial<Env> = {}): Env {
  return {
    DB: db,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    JWT_SECRET,
    PROXY_SHARED_SECRET: SECRET,
    REQUIRE_LOGIN: "0", // 匿名也走完整检索（避免"登录回退"分支掩盖真实代码路径）；无上游 key → 自然落关键词回退
    ...over,
  } as unknown as Env
}

/** 代理转发头（凭据匹配 → 采信 x-prism-*，定档 overseas 10/min）。 */
const proxyHeaders = {
  "x-prism-proxy": SECRET,
  "x-prism-client-ip": "203.0.113.7",
  "x-prism-country": "US",
  "x-prism-asn": "16509",
}

function searchReq(env: Env, headers: Record<string, string> = {}) {
  return app.request(
    "/api/v1/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...proxyHeaders, ...headers },
      body: JSON.stringify({ query: "激素", corpora: ["mtf-wiki"] }),
    },
    env,
  )
}

async function token(env: Env) {
  return await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
}

describe("D1 往返次数（性能验收：/search ≤ 5）", () => {
  it("匿名 /search：只走限流闸门（封禁读 1 + 突发 1 + 分档 1 + 全局熔断 1 = 4）", async () => {
    const { db, stats } = makeCountingDb()
    const env = makeEnv(db)
    const resp = await searchReq(env)
    expect(resp.status).toBe(200)
    expect(stats.roundtrips).toBeLessThanOrEqual(5)
    expect(stats.roundtrips).toBe(4)
  })

  it("登录 /search：闸门 3（无全局熔断）+ 配额 2（建窗 1 + 原子扣费 1）= 5", async () => {
    const { db, stats } = makeCountingDb()
    const env = makeEnv(db)
    const tok = await token(env)
    const resp = await searchReq(env, { Authorization: `Bearer ${tok}` })
    expect(resp.status).toBe(200)
    expect(stats.roundtrips).toBeLessThanOrEqual(5)
    expect(stats.roundtrips).toBe(5)
  })

  it("登录 /search 的响应仍带真实配额（不重复取 getQuota）", async () => {
    const { db } = makeCountingDb()
    const env = makeEnv(db)
    const tok = await token(env)
    const body = (await (await searchReq(env, { Authorization: `Bearer ${tok}` })).json()) as {
      quota?: { used_pct?: number; remaining_pct?: number }
    }
    // 默认 QUOTA_WINDOW_TOKENS=300000，纯搜索 200 → 0.1%（保留 1 位小数）
    expect(body.quota?.used_pct).toBe(0.1)
    expect(body.quota?.remaining_pct).toBe(99.9)
  })

  it("登录 /search/stream（不带 LLM）：闸门 3 + 配额 2 = 5（流内不再单独查配额）", async () => {
    const { db, stats } = makeCountingDb()
    const env = makeEnv(db)
    const tok = await token(env)
    const resp = await app.request(
      "/api/v1/search/stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, ...proxyHeaders },
        body: JSON.stringify({ query: "激素", corpora: ["mtf-wiki"], use_llm: false }),
      },
      env,
    )
    expect(resp.status).toBe(200)
    await resp.text() // 消费 SSE 流（流内的 D1 操作在 start() 里发生）
    expect(stats.roundtrips).toBeLessThanOrEqual(5)
    expect(stats.roundtrips).toBe(5)
  })

  it("封禁期内：只读一次封禁行（往返 = 1），且**不占任何名额**（计数不变）", async () => {
    const { db, stats, rate } = makeCountingDb()
    const env = makeEnv(db, { BURST_PER_10S: "3" })
    const h = { ...proxyHeaders, "x-prism-country": "CN", "x-prism-asn": "4134" } // cn_residential 30/min（不会先被档位拦住）
    const req = () =>
      app.request(
        "/api/v1/search",
        { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify({ query: "激素", corpora: ["mtf-wiki"] }) },
        env,
      )
    for (let i = 0; i < 3; i++) expect((await req()).status).toBe(200)
    const burst = await req() // 第 4 次：突发桶 4 > 3 → 429 + 封禁
    expect(burst.status).toBe(429)
    expect(((await burst.json()) as { scope: string }).scope).toBe("burst")

    // 封禁期内的下一次请求：往返 = 1（只读封禁行），计数**一行都不变**
    const before = stats.roundtrips
    const countsBefore = [...rate.values()].map((r) => `${r.bucket_key}:${r.count}`).sort()
    const blocked = await req()
    expect(blocked.status).toBe(429)
    expect(((await blocked.json()) as { scope: string }).scope).toBe("blocked")
    expect(stats.roundtrips - before).toBe(1)
    expect([...rate.values()].map((r) => `${r.bucket_key}:${r.count}`).sort()).toEqual(countsBefore)
  })

  it("写放大不变：预热后一次匿名搜索 = 3 行（分档桶 + 突发桶 + 全局桶），与优化前一致", async () => {
    const { db, stats } = makeCountingDb()
    const env = makeEnv(db)
    await searchReq(env) // 预热：本轮会 INSERT 三个桶（冷启动，行数不计入）
    const before = stats.rowsChanged
    await searchReq(env)
    expect(stats.rowsChanged - before).toBe(3) // 三个桶各 UPDATE 1 行；补行语句已存在 → 0 行
  })

  it("GET /me：账号读 1 + 配额上下文 1 = 2（配额的两次顺序读已合并成一次 batch）", async () => {
    const { db, stats } = makeCountingDb()
    const env = makeEnv(db)
    const tok = await token(env)
    const resp = await app.request("/api/v1/me", { headers: { Authorization: `Bearer ${tok}` } }, env)
    expect(resp.status).toBe(200)
    expect(stats.roundtrips).toBe(2)
  })

  it("/chat（会话不存在 → 404）：闸门 3 + 会话读 1 = 4（chat_sessions 自身 I/O 不计入本次目标）", async () => {
    const { db, stats } = makeCountingDb()
    const env = makeEnv(db)
    const tok = await token(env)
    const resp = await app.request(
      "/api/v1/chat",
      {
        method: "POST",
        // 必须带 IP（cf-connecting-ip）：闸门里的封禁读与突发层都以"有 IP"为前提（无 IP 时那两层跳过）
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ session_id: "s-1", question: "在吗" }),
      },
      env,
    )
    // 会话不存在 → 404；关键是**它之前的闸门只花了 3 次往返**（不再是 7 次）
    expect(resp.status).toBe(404)
    expect(stats.roundtrips).toBe(4) // 闸门 3（封禁读 + 突发 + 分档；/chat 不参与全局匿名熔断）+ loadContext 1
  })

  it("/chat（会话存在、LLM 未配置 → 503）：闸门 3 + 会话读 1 + 追加一轮 2 = 6", async () => {
    const { db, stats, chat } = makeCountingDb()
    chat.set("s-1", {
      id: "s-1",
      account_id: "acc-1",
      model_id: "default",
      corpora: "[]",
      round_count: 0,
      initial_hits: "[]",
      history: "[]",
      created_at: NOW_MS,
      updated_at: NOW_MS,
    })
    const env = makeEnv(db)
    const tok = await token(env)
    const resp = await app.request(
      "/api/v1/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ session_id: "s-1", question: "在吗" }),
      },
      env,
    )
    expect(resp.status).toBe(503) // 没配 LLM key → llm-unavailable（未扣配额）
    // 构成：闸门 3（封禁读/突发/分档）+ loadContext 1 + appendRound(loadContext 1 + UPDATE 1)
    // 配额扣费发生在回答之后，本用例走不到；多出的 3 次是 chat_sessions 自身 I/O（非本次优化目标）
    expect(stats.roundtrips).toBe(6)
  })
})
