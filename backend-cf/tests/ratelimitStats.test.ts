// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — GET /api/v1/admin/ratelimit（只读观测）+ 突发层顺序修复 单测
// （plan-ratelimit.md §5/§6/§10 R5/§11；history.md §5 坑 35–38）
//
// 全 mock：D1 用内存假表（严格实现 rate_counters 的 SQL 形状），零网络、零真实密钥。
// 覆盖：
//   ① 聚合正确性：buckets/counted/by tier/by scope、时间范围（当前窗口 + 上一窗口）、封禁行数、
//      全局熔断状态（normal/soft/hard）、limits 与 env 同源、非标准档位名 → limit=null；
//   ② 失败语义：缺 D1 → 503 db-unconfigured；读失败 → 503 db-unavailable；未鉴权 → 401；
//   ③ **绝不写库**：D1 mock 的 run() 一旦被调用即抛错 + 记录，用例断言写入集合为空
//      （匿名搜索已是 3 行写/请求，观测端点不得再加任何每请求写）；
//   ④ 突发层顺序修复：被档位拒绝的请求**仍计入突发桶**；第 21 个请求 → scope=burst；
//      随后 → scope=blocked（Retry-After ≈ 60）；CN 家宽正常节奏不会误触 20/10s。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { withBatch } from "./d1MockBatch"
import { app } from "../src/index"
import { GLOBAL_TIER_VALUE, STATS_WINDOWS, aggregateRateLimitRows } from "../src/ratecount"
import type { Env } from "../src/types"

const SECRET = "proxy-shared-secret"
const ADMIN_KEY = "admin-secret"

/** 与 60s 窗口对齐的"现在"（12:00:30 → 当前窗口 12:00:00，上一窗口 11:59:00）。 */
const NOW = Date.UTC(2026, 8, 10, 12, 0, 30)
const WINDOW_MS = 60_000
const CURRENT_START = Date.UTC(2026, 8, 10, 12, 0, 0)
const PREV_START = CURRENT_START - WINDOW_MS

interface SeedRow {
  bucket_key: string
  tier: string
  window_start: number
  window_sec: number
  count: number
  updated_at: number
}

/**
 * 只读观测用的 D1 假表：**任何写语句都会抛错并记账**（断言"观测端点不写库"）。
 * 聚合 SQL 的语义（`window_start >= ?` + `tier NOT LIKE 'block:%'` + GROUP BY）在这里逐字复现，
 * 于是"时间范围口径"是被真正测到的（改 STATS_WINDOWS / 改 WHERE 条件都会让用例失败）。
 */
function makeStatsDb(rows: SeedRow[], opts: { failAll?: boolean; failFirst?: boolean } = {}) {
  const writes: string[] = []
  const reads: Array<{ sql: string; args: unknown[] }> = []
  const prefixOf = (pattern: unknown) => String(pattern ?? "").replace(/%$/, "")

  const db = {
    prepare(sql: string) {
      const rec = { sql, args: [] as unknown[] }
      const stmt = {
        bind(...args: unknown[]) {
          rec.args = args
          return stmt
        },
        async run() {
          // 观测端点永远不该走到这里；走到即失败（并留下证据）
          writes.push(sql)
          throw new Error(`write-attempted: ${sql}`)
        },
        async all() {
          reads.push(rec)
          if (opts.failAll) throw new Error("d1-failed")
          if (!/GROUP BY tier, window_start/.test(sql)) return { success: true, results: [], meta: { changes: 0 } }
          const [rangeStart, likePattern] = rec.args as [number, string]
          const prefix = prefixOf(likePattern)
          const groups = new Map<string, { tier: string; window_start: number; buckets: number; counted: number }>()
          for (const r of rows) {
            if (r.window_start < Number(rangeStart)) continue
            if (prefix && r.tier.startsWith(prefix)) continue
            const key = `${r.tier}|${r.window_start}`
            const g = groups.get(key) ?? { tier: r.tier, window_start: r.window_start, buckets: 0, counted: 0 }
            g.buckets += 1
            g.counted += r.count
            groups.set(key, g)
          }
          return { success: true, results: [...groups.values()], meta: { changes: 0 } }
        },
        async first() {
          reads.push(rec)
          if (opts.failAll || opts.failFirst) throw new Error("d1-failed")
          if (!/COUNT\(\*\) AS blocked/.test(sql)) return null
          const [rangeStart, likePattern, nowMs] = rec.args as [number, string, number]
          const prefix = prefixOf(likePattern)
          const n = rows.filter(
            (r) => r.window_start >= Number(rangeStart) && r.tier.startsWith(prefix) && r.count > Number(nowMs),
          ).length
          return { blocked: n }
        },
      }
      return stmt
    },
  } as unknown as D1Database
  return { db: withBatch(db as unknown as { prepare: (sql: string) => unknown }) as unknown as D1Database, writes, reads }
}

function adminEnv(over: Partial<Env> = {}): Env {
  return {
    DB: undefined as never,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    ADMIN_API_KEY: ADMIN_KEY,
    PROXY_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env
}

function callStats(env: Env, headers: Record<string, string> = {}) {
  return app.request(
    "/api/v1/admin/ratelimit",
    { headers: { Authorization: `Bearer ${ADMIN_KEY}`, ...headers } },
    env,
  )
}

/** 观测用的种子行（bucket_key 是 HMAC 摘要形状的假串，**绝不是 IP**）。 */
function seedRows(): SeedRow[] {
  const row = (tier: string, windowStart: number, count: number, n: number): SeedRow => ({
    bucket_key: `deadbeef${n.toString().padStart(4, "0")}`,
    tier,
    window_start: windowStart,
    window_sec: 60,
    count,
    updated_at: windowStart,
  })
  return [
    // search 桶（裸档位名）
    row("overseas", CURRENT_START, 7, 1),
    row("overseas", PREV_START, 3, 2),
    row("overseas", PREV_START - WINDOW_MS, 99, 3), // 范围外（上上个窗口）→ 必须被 SQL 过滤
    // llm 桶（`llm:` 前缀）
    row("llm:overseas", CURRENT_START, 12, 4),
    row("llm:logged_in", CURRENT_START, 5, 5),
    // 登录搜索桶
    row("logged_in", CURRENT_START, 60, 6),
    // 突发桶（10s 窗口，落在最近 2 分钟内）
    row("burst:overseas", CURRENT_START, 20, 7),
    row("burst:cn_idc", CURRENT_START - 5_000, 20, 8),
    // 全局匿名熔断桶（当前窗口 601 > 软阈值 600 → soft）
    row(GLOBAL_TIER_VALUE, CURRENT_START, 601, 9),
    row(GLOBAL_TIER_VALUE, PREV_START, 900, 10), // 上一窗口：**不计入**当前熔断状态
    // 封禁行（count 列借存 block_until）：一条未过期、一条已过期
    row("block:overseas", CURRENT_START, NOW + 40_000, 11),
    row("block:cn_idc", CURRENT_START, NOW - 1_000, 12),
    // 非标准档位名（理论上不该出现）：聚合出来但 limit=null（**不编造**）
    row("weird-tier", CURRENT_START, 2, 13),
  ]
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// 只 fake `Date`（不动定时器）：路由里的 `Date.now()` 与窗口计算全部对齐到 NOW，用例才可确定。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
})

describe("GET /api/v1/admin/ratelimit：只读聚合（plan §10 R5）", () => {
  it("按 tier/scope 聚合 buckets/counted，时间范围 = 当前窗口 + 上一窗口，范围外的行不计", async () => {
    const { db, writes, reads } = makeStatsDb(seedRows())
    const resp = await callStats(adminEnv({ DB: db }))
    expect(resp.status).toBe(200)
    expect(writes).toEqual([]) // 本用例也顺带锁死"不写库"

    const body = (await resp.json()) as Record<string, any>
    // 窗口口径
    expect(STATS_WINDOWS).toBe(2)
    expect(body.window_sec).toBe(60)
    expect(body.window_start).toBe(CURRENT_START)
    expect(body.range_start).toBe(PREV_START)
    expect(typeof body.now).toBe("number")

    // scopes：search = overseas 当前窗口 7 + 上一窗口 3 + logged_in 60 + weird-tier 2
    //（上上个窗口的 99 **不计**）；llm 只认 `llm:` 前缀的行
    expect(body.scopes.search).toEqual({ buckets: 4, counted: 72 })
    expect(body.scopes.llm).toEqual({ buckets: 2, counted: 17 })
    expect(body.scopes.burst).toEqual({ buckets: 2, counted: 40 })
    // global 只取当前窗口（上一窗口的 900 不计）
    expect(body.scopes.global).toEqual({ buckets: 1, counted: 601 })

    // tiers：search + llm 合并按档位呈现，顺序 = TIERS 顺序（logged_in → overseas），最后是非标准名
    expect(body.tiers).toEqual([
      { tier: "logged_in", buckets: 2, counted: 65, limit: 60 },
      { tier: "overseas", buckets: 3, counted: 22, limit: 10 },
      { tier: "weird-tier", buckets: 1, counted: 2, limit: null },
    ])

    // 封禁行数：只有 block_until > now 的那条
    expect(body.blocked_buckets).toBe(1)

    // 全局熔断状态（与 rateGate 同口径：count > soft → soft）
    expect(body.global).toEqual({ count: 601, soft: 600, hard: 1200, state: "soft" })

    // limits 与 env 同源（默认值）
    expect(body.limits).toEqual({
      logged_in: 60,
      cn_residential: 30,
      cn_other: 15,
      cn_idc: 6,
      overseas: 10,
      unknown: 5,
      llm_divisor: 5,
    })
    expect(body.degraded).toBe(false)

    // SQL 形状：两条 SELECT，范围条件走 window_start（idx_rate_counters_window），不做全表扫描
    expect(reads).toHaveLength(2)
    expect(reads[0].sql).toContain("FROM rate_counters")
    expect(reads[0].sql).toContain("window_start >= ?")
    expect(reads[0].sql).toContain("GROUP BY tier, window_start")
    expect(reads[0].args[0]).toBe(PREV_START)
    expect(reads[1].sql).toContain("COUNT(*) AS blocked")
    expect(reads[1].args[2]).toBeGreaterThan(0) // nowMs 作为比较值传入
  })

  it("**绝不写库**：两条 SELECT 之外不产生任何 run()/写语句（匿名搜索已是 3 行写，观测不得再加）", async () => {
    const { db, writes } = makeStatsDb(seedRows())
    const resp = await callStats(adminEnv({ DB: db }))
    expect(resp.status).toBe(200)
    expect(writes).toEqual([]) // 任何写都会既抛错又在这里留下证据
  })

  it("limits / 熔断阈值随 env 变化（面板显示的就是线上生效值）", async () => {
    const { db } = makeStatsDb([{ bucket_key: "aa", tier: "unknown", window_start: CURRENT_START, window_sec: 60, count: 3, updated_at: CURRENT_START }])
    const resp = await callStats(
      adminEnv({
        DB: db,
        RATE_LIMIT_OVERSEAS_PER_MIN: "7",
        RATE_LIMIT_LLM_DIVISOR: "4",
        ANON_GLOBAL_PER_MIN: "10",
        ANON_GLOBAL_HARD_PER_MIN: "11",
      }),
    )
    const body = (await resp.json()) as Record<string, any>
    expect(body.limits.overseas).toBe(7)
    expect(body.limits.llm_divisor).toBe(4)
    expect(body.global.soft).toBe(10)
    expect(body.global.hard).toBe(11)
    expect(body.tiers).toEqual([{ tier: "unknown", buckets: 1, counted: 3, limit: 5 }])
  })

  it("未配 PROXY_SHARED_SECRET → degraded=true（桶匿名化强度下降）；配了 → false", async () => {
    const { db } = makeStatsDb([])
    const degraded = await callStats(adminEnv({ DB: db, PROXY_SHARED_SECRET: undefined as never }))
    expect(((await degraded.json()) as { degraded: boolean }).degraded).toBe(true)
    const ok = await callStats(adminEnv({ DB: makeStatsDb([]).db }))
    expect(((await ok.json()) as { degraded: boolean }).degraded).toBe(false)
  })

  it("空表 → 200 且各聚合归零（新窗口/未开始计数时是正常态，不报错）", async () => {
    const { db, writes } = makeStatsDb([])
    const resp = await callStats(adminEnv({ DB: db }))
    const body = (await resp.json()) as Record<string, any>
    expect(resp.status).toBe(200)
    expect(body.tiers).toEqual([])
    expect(body.scopes).toEqual({
      search: { buckets: 0, counted: 0 },
      llm: { buckets: 0, counted: 0 },
      burst: { buckets: 0, counted: 0 },
      global: { buckets: 0, counted: 0 },
    })
    expect(body.blocked_buckets).toBe(0)
    expect(body.global.state).toBe("normal")
    expect(writes).toEqual([])
  })

  it("缺 D1 → 503 db-unconfigured；读失败 → 503 db-unavailable（与 /admin/usage 同款）", async () => {
    const noDb = await callStats(adminEnv({ DB: undefined as never }))
    expect(noDb.status).toBe(503)
    expect(await noDb.json()).toEqual({ error: "db-unconfigured" })

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const allFail = await callStats(adminEnv({ DB: makeStatsDb(seedRows(), { failAll: true }).db }))
    expect(allFail.status).toBe(503)
    expect(await allFail.json()).toEqual({ error: "db-unavailable" })

    const firstFail = await callStats(adminEnv({ DB: makeStatsDb(seedRows(), { failFirst: true }).db }))
    expect(firstFail.status).toBe(503)
    expect(await firstFail.json()).toEqual({ error: "db-unavailable" })
    expect(warn.mock.calls.flat().join(" ")).toContain("ratelimit aggregation failed")
  })

  it("沿用 admin 鉴权：无 Bearer / 错 key → 401（且不触发任何 D1 读）", async () => {
    const { db, reads } = makeStatsDb(seedRows())
    const env = adminEnv({ DB: db })
    expect((await app.request("/api/v1/admin/ratelimit", {}, env)).status).toBe(401)
    expect(
      (await app.request("/api/v1/admin/ratelimit", { headers: { Authorization: "Bearer wrong" } }, env)).status,
    ).toBe(401)
    expect(reads).toEqual([])
  })

  it("响应体不含 IP / 桶 key / 任何密钥（隐私验收项）", async () => {
    const { db } = makeStatsDb(seedRows())
    const resp = await callStats(adminEnv({ DB: db }))
    const raw = JSON.stringify(await resp.json())
    expect(raw).not.toContain("deadbeef0001") // 桶 key 绝不外泄
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain(ADMIN_KEY)
    expect(raw).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/) // 没有任何 IPv4 形状
  })
})

describe("aggregateRateLimitRows：纯函数口径（零 IO）", () => {
  it("全局熔断 state 与 rateGate 判定逐字对应（normal / soft / hard）", () => {
    const agg = (count: number) =>
      aggregateRateLimitRows(
        [{ tier: GLOBAL_TIER_VALUE, window_start: CURRENT_START, buckets: 1, counted: count }],
        0,
        { nowMs: NOW, env: { ANON_GLOBAL_PER_MIN: "10", ANON_GLOBAL_HARD_PER_MIN: "20" } },
      ).global
    expect(agg(10)).toEqual({ count: 10, soft: 10, hard: 20, state: "normal" })
    expect(agg(11).state).toBe("soft")
    expect(agg(19).state).toBe("soft")
    expect(agg(20).state).toBe("hard") // 原子「判-占」在 count == hard 时开始拒绝
    expect(agg(25).state).toBe("hard")
  })

  it("脏行（缺 tier / 负 count / 非数字窗口 / buckets=0）被安全忽略，不产生 NaN", () => {
    const stats = aggregateRateLimitRows(
      [
        { tier: null, window_start: CURRENT_START, buckets: 3, counted: 3 },
        { tier: "overseas", window_start: "nope", buckets: 1, counted: 1 },
        { tier: "overseas", window_start: CURRENT_START, buckets: 0, counted: 5 },
        { tier: "overseas", window_start: CURRENT_START, buckets: 2, counted: -7 },
      ],
      0,
      { nowMs: NOW },
    )
    expect(stats.scopes.search).toEqual({ buckets: 2, counted: 0 })
    expect(stats.tiers).toEqual([{ tier: "overseas", buckets: 2, counted: 0, limit: 10 }])
  })

  it("封禁行永远不进 counted（count 列是 block_until，不是计数）", () => {
    const stats = aggregateRateLimitRows(
      [
        { tier: "block:overseas", window_start: CURRENT_START, buckets: 1, counted: NOW + 60_000 },
        { tier: "burst:overseas", window_start: CURRENT_START, buckets: 1, counted: 4 },
      ],
      1,
      { nowMs: NOW },
    )
    expect(stats.scopes.search).toEqual({ buckets: 0, counted: 0 })
    expect(stats.scopes.burst).toEqual({ buckets: 1, counted: 4 })
    expect(stats.tiers).toEqual([])
    expect(stats.blocked_buckets).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 突发层顺序修复（2026-09-10）：② 突发 必须在 ③ 分档计数 **之前**
// 原顺序（分档 → 突发）下，被档位拒绝的请求在 ② 就 return，永远进不到突发层；
// 而突发阈值 20/10s（=120/min）高于所有档位上限（最高 60/min）→ 突发层是死代码
// （线上实测：40 并发境外档 → 10×200 + 30×429，scope 全是 tier-limit，burst 出现 0 次）。
// ─────────────────────────────────────────────────────────────────────────────

interface RateRow {
  bucket_key: string
  tier: string
  window_start: number
  window_sec: number
  count: number
  updated_at: number
}

/** 严格的 rate_counters 假表（与 src/ratecount.ts 的 SQL 形状一一对应）。 */
function makeRateDb() {
  const rows = new Map<string, RateRow>()
  const apply = (sql: string, args: unknown[]): number => {
    if (sql.includes("INSERT OR IGNORE INTO rate_counters")) {
      if (sql.includes("VALUES (?, ?, ?, ?, ?, ?)")) {
        const [key, tier, ws, sec, count, updatedAt] = args as [string, string, number, number, number, number]
        if (rows.has(key)) return 0
        rows.set(key, { bucket_key: key, tier, window_start: ws, window_sec: sec, count, updated_at: updatedAt })
        return 1
      }
      const [key, tier, ws, sec, updatedAt] = args as [string, string, number, number, number]
      if (rows.has(key)) return 0
      rows.set(key, { bucket_key: key, tier, window_start: ws, window_sec: sec, count: 0, updated_at: updatedAt })
      return 1
    }
    if (sql.includes("count = count + 1")) {
      const [updatedAt, key, limit] = args as [number, string, number]
      const row = rows.get(key)
      if (!row || row.count >= limit) return 0
      row.count += 1
      row.updated_at = updatedAt
      return 1
    }
    if (sql.startsWith("UPDATE rate_counters SET count = ?")) {
      const [count, ws, sec, updatedAt, key] = args as [number, number, number, number, string]
      const row = rows.get(key)
      if (!row) return 0
      row.count = count
      row.window_start = ws
      row.window_sec = sec
      row.updated_at = updatedAt
      return 1
    }
    if (sql.startsWith("DELETE FROM rate_counters")) return 0
    return 0
  }
  const db = {
    prepare(sql: string) {
      const rec = { sql, args: [] as unknown[] }
      const stmt = {
        bind(...args: unknown[]) {
          rec.args = args
          return stmt
        },
        async first() {
          if (sql.includes("SELECT count FROM rate_counters")) {
            const row = rows.get(String(rec.args[0]))
            return row ? { count: row.count } : null
          }
          return null
        },
        async run() {
          return { success: true, results: [], meta: { changes: apply(sql, rec.args) } }
        },
      }
      return stmt
    },
  } as unknown as D1Database
  return { db: withBatch(db as unknown as { prepare: (sql: string) => unknown }) as unknown as D1Database, rows }
}

/** 经代理转发的境外 IP（overseas 档 = 10 次/分钟）。 */
function proxyHeaders(over: Record<string, string> = {}): Record<string, string> {
  return {
    "x-prism-proxy": SECRET,
    "x-prism-client-ip": "203.0.113.7",
    "x-prism-country": "US",
    "x-prism-asn": "16509",
    ...over,
  }
}

function burstEnv(over: Partial<Env> = {}, db: D1Database = makeRateDb().db): Env {
  return {
    DB: db,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    PROXY_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env
}

function searchCall(env: Env, headers: Record<string, string> = proxyHeaders()) {
  return app.request(
    "/api/v1/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query: "激素", corpora: ["mtf-wiki"] }),
    },
    env,
  )
}

const scopeOf = async (resp: Response) => ((await resp.json()) as { scope?: string }).scope

describe("突发层顺序修复：突发必须先于分档计数（否则是被提前 return 架空的死代码）", () => {
  it("档位额度耗尽后继续打：**突发桶计数仍在增长**（被档位拒绝的请求也进突发层）", async () => {
    const { db, rows } = makeRateDb()
    const env = burstEnv({}, db)

    for (let i = 1; i <= 10; i++) expect((await searchCall(env)).status, `第 ${i} 次`).toBe(200)
    // 11–15 次：档位已满 → 429，但突发桶必须继续累加（burst 15 > 档位上限 10）
    for (let i = 11; i <= 15; i++) {
      const denied = await searchCall(env)
      expect(denied.status, `第 ${i} 次`).toBe(429)
      expect(await scopeOf(denied)).toBe("tier-limit")
      const burstRow = [...rows.values()].find((r) => r.tier === "burst:overseas")!
      expect(burstRow.count, `第 ${i} 次后的突发计数`).toBe(i)
    }
    // 分档桶仍停在 10（被拒的请求不占档位名额）
    expect([...rows.values()].find((r) => r.tier === "overseas")!.count).toBe(10)
    expect([...rows.values()].find((r) => r.tier === "burst:overseas")!.count).toBe(15)
  })

  it("10 秒内第 21 个请求 → 429 scope=burst，随后一律 429 scope=blocked（Retry-After ≈ 60）", async () => {
    const { db, rows } = makeRateDb()
    const env = burstEnv({}, db)

    // 1–20：前 10 次 200，后 10 次 tier-limit（**全部计入突发桶**）
    for (let i = 1; i <= 10; i++) expect((await searchCall(env)).status, `第 ${i} 次`).toBe(200)
    for (let i = 11; i <= 20; i++) {
      expect(await scopeOf(await searchCall(env)), `第 ${i} 次`).toBe("tier-limit")
    }

    const burst = await searchCall(env)
    expect(burst.status).toBe(429)
    expect(await scopeOf(burst)).toBe("burst")
    expect(Number(burst.headers.get("Retry-After"))).toBeGreaterThan(60 - 5)
    expect(burst.headers.get("X-RateLimit-Remaining")).toBe("0")
    // 突发触发必须写下封禁行（封禁期内一律 429）
    const blockRow = [...rows.values()].find((r) => r.tier === "block:overseas")
    expect(blockRow).toBeDefined()
    expect(blockRow!.count).toBeGreaterThan(Date.now())

    const blocked = await searchCall(env)
    expect(blocked.status).toBe(429)
    expect(await scopeOf(blocked)).toBe("blocked")
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(60 - 5)
    // 封禁期内不再占任何名额（突发桶停在 20）
    expect([...rows.values()].find((r) => r.tier === "burst:overseas")!.count).toBe(20)
  })

  it("CN 家宽正常节奏（30/分钟 ≈ 每 2 秒 1 次）不会误触 20/10s 的突发", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const start = Date.UTC(2026, 8, 10, 12, 0, 0) // 对齐窗口边界
    const { db, rows } = makeRateDb()
    const env = burstEnv({}, db)
    const h = proxyHeaders({ "x-prism-country": "CN", "x-prism-asn": "4134" }) // cn_residential 30/min

    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(start + i * 2_000)
      const resp = await searchCall(env, h)
      expect(resp.status, `第 ${i + 1} 次（t+${i * 2}s）`).toBe(200)
    }
    // 30 次分散在 58 秒内：突发桶峰值 5/10s，永远够不到 20 → 不封禁
    expect([...rows.values()].some((r) => r.tier.startsWith("block:"))).toBe(false)
    expect([...rows.values()].find((r) => r.tier === "burst:cn_residential")!.count).toBeLessThan(20)
  })
})
