// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 配额计量与原子扣减单测（tasks.md T3.2，滚动 5h 窗口 + 加权 token 模型）
// R6 追加：窗口改为**按注册时间网格锚定**（plan-ratelimit.md §9.2）—— 重置时刻固定可预测。
// 全 mock：D1 用内存假表实现「条件 UPDATE + meta.changes」语义，零网络、零真实 key。
// 重点：① 窗口内累计；② 跨 5h 自动开新窗口；③ 并发不超卖；④ 超额不抛错只回 reason；
//       ⑤ used_pct 计算与 clamp；⑥ env 缺失/非法回默认值；⑦ 缺 D1 优雅降级；
//       ⑧ **网格锚定**：对齐/清零/同窗口不清零/并发不抹用量/accounts 缺失回退；
//       ⑨ 视图重置字段 window_end / reset_at / reset_in_sec。
import { describe, it, expect, vi } from "vitest"
import { withBatch } from "./d1MockBatch"
import {
  QUOTA_COST,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_LIMIT_TOKENS,
  LOW_QUOTA_PCT,
  windowHours,
  windowMs,
  gridWindowStart,
  limitTokens,
  usedPct,
  formatPct,
  computeQuotaCost,
  isLowQuota,
  toQuotaResponse,
  getQuota,
  ensureWindow,
  chargeQuota,
  grantQuota,
  resetQuota,
  type QuotaView,
} from "../src/quota"

/** 基准时间与窗口常量。 */
const NOW = Date.UTC(2026, 8, 9, 12, 0, 0)
const HOUR_MS = 3_600_000
const WINDOW_MS = DEFAULT_WINDOW_HOURS * HOUR_MS // 5h

interface FakeRow {
  period_start: number
  used_cost: number
  monthly_limit: number
  /** 本窗口"扣费成功"的请求数（技术债 #4；旧库没有这一列，见 makeDb 的 noRequestsColumn） */
  requests: number
  updated_at: number
}

/**
 * 内存 D1 假表：按 SQL 形状识别语句，实现与 quota.ts 完全一致的语义
 * （特别是条件 UPDATE 的 meta.changes 判定）。遇到未识别 SQL 直接抛错，防止实现漂移后测试静默通过。
 *
 * `accounts`（网格锚）默认取该账号 quotas 行的 `period_start`：当 `now - created_at < windowMs` 时
 * 网格起点恰等于 `period_start`，因此既有用例语义不变；显式传 `{ "acc-1": <created_at> }` 可覆盖，
 * 传 `null` 表示"该账号没有 accounts 行"（测回退到 now 锚）。
 */
function makeDb(
  seed: Record<string, Partial<FakeRow>> = {},
  failOn?: string,
  accounts?: Record<string, number | null>,
  /** true = 模拟"还没跑 apply-schema"的旧库：任何提到 requests 列的语句都报 no such column */
  noRequestsColumn = false,
) {
  const rows = new Map<string, FakeRow>()
  const accs = new Map<string, number>()
  for (const [id, r] of Object.entries(seed)) {
    rows.set(id, {
      period_start: r.period_start ?? NOW,
      used_cost: r.used_cost ?? 0,
      monthly_limit: r.monthly_limit ?? 5,
      requests: r.requests ?? 0,
      updated_at: r.updated_at ?? NOW,
    })
    accs.set(id, r.period_start ?? NOW)
  }
  if (accounts) {
    for (const [id, created] of Object.entries(accounts)) {
      if (created === null) accs.delete(id)
      else accs.set(id, created)
    }
  }
  const calls: Array<{ sql: string; args: unknown[] }> = []

  const apply = (sql: string, args: unknown[]): number => {
    // 旧库模拟：凡出现 `requests` 的语句都报 no such column（chargeQuota 应退化为旧语句）
    if (noRequestsColumn && /\brequests\b/.test(sql)) throw new Error("SQLITE_ERROR: no such column: requests")
    if (sql.includes("INSERT OR IGNORE INTO quotas")) {
      const [accountId, windowStart, legacyLimit, updatedAt] = args as [string, number, number, number]
      if (rows.has(accountId)) return 0
      rows.set(accountId, {
        period_start: windowStart,
        used_cost: 0,
        monthly_limit: legacyLimit,
        requests: 0,
        updated_at: updatedAt,
      })
      return 1
    }
    if (sql.includes("SET requests = 0") && sql.includes("AND period_start < ?")) {
      // ensureWindow ⓪：窗口切换前清零"本窗口请求数"（条件写：只碰还停在旧窗口的行）
      const [accountId, threshold] = args as [string, number]
      const row = rows.get(accountId)
      if (!row || !(row.period_start < threshold)) return 0
      row.requests = 0
      return 1
    }
    if (sql.includes("used_cost = 0") && sql.includes("AND period_start < ?")) {
      // ensureWindow ①：网格推进 → 清零 + 对齐（单条条件写）
      const [windowStart, updatedAt, accountId, threshold] = args as [number, number, string, number]
      const row = rows.get(accountId)
      if (!row || !(row.period_start < threshold)) return 0
      row.used_cost = 0
      row.period_start = windowStart
      row.updated_at = updatedAt
      return 1
    }
    if (sql.includes("AND period_start > ? AND period_start < ?")) {
      // ensureWindow ②：同窗口内错位 → 只对齐起点，**不清零**
      const [windowStart, updatedAt, accountId, lower, upper] = args as [number, number, string, number, number]
      const row = rows.get(accountId)
      if (!row || !(row.period_start > lower) || !(row.period_start < upper)) return 0
      row.period_start = windowStart
      row.updated_at = updatedAt
      return 1
    }
    if (sql.includes("used_cost = used_cost + ?")) {
      // chargeQuota：单条原子「判-扣」（token 值绑定两次：累加 + 判额）
      const [cost, updatedAt, accountId, guard, limit] = args as [number, number, string, number, number]
      if (guard !== cost) throw new Error("guard-arg-mismatch")
      const row = rows.get(accountId)
      if (!row) return 0
      if (row.used_cost + cost > limit) return 0
      row.used_cost += cost
      // 与 used_cost 同语句自增（技术债 #4）：只有真正扣成功才 +1
      if (sql.includes("requests = requests + 1")) row.requests += 1
      row.updated_at = updatedAt
      return 1
    }
    if (sql.includes("used_cost = MIN(?, MAX(0.0")) {
      // grantQuota：加/扣额，两端夹住
      const [limit, delta, updatedAt, accountId] = args as [number, number, number, string]
      const row = rows.get(accountId)
      if (!row) return 0
      row.used_cost = Math.min(limit, Math.max(0, row.used_cost - delta))
      row.updated_at = updatedAt
      return 1
    }
    if (sql.includes("SET used_cost = 0, period_start = ?") && !sql.includes("period_start < ?")) {
      // resetQuota
      const [windowStart, updatedAt, accountId] = args as [number, number, string]
      const row = rows.get(accountId)
      if (!row) return 0
      row.used_cost = 0
      row.period_start = windowStart
      row.updated_at = updatedAt
      return 1
    }
    throw new Error(`unhandled-sql: ${sql}`)
  }

  const db = {
    prepare(sql: string) {
      const rec = { sql, args: [] as unknown[] }
      const stmt = {
        bind(...args: unknown[]) {
          rec.args = args
          calls.push(rec)
          return stmt
        },
        async first() {
          if (failOn && sql.includes(failOn)) throw new Error("d1-failed")
          if (sql.includes("SELECT created_at FROM accounts")) {
            const created = accs.get(String(rec.args[0]))
            return created === undefined ? null : { created_at: created }
          }
          if (!sql.includes("SELECT period_start")) return null
          const row = rows.get(String(rec.args[0]))
          return row ? { period_start: row.period_start, used_cost: row.used_cost, monthly_limit: row.monthly_limit } : null
        },
        async run() {
          if (failOn && sql.includes(failOn)) throw new Error("d1-failed")
          return { success: true, results: [], meta: { changes: apply(sql, rec.args) } }
        },
      }
      return stmt
    },
  } as unknown as D1Database

  return { db: withBatch(db as unknown as { prepare: (sql: string) => unknown }) as unknown as D1Database, rows, accs, calls }
}

describe("加权 token 成本表", () => {
  it("常量：纯搜索 200 / rerank +100 / 回退 0；默认窗口 5h、额度 300k", () => {
    expect(QUOTA_COST).toEqual({ search: 200, rerank: 100, fallback: 0 })
    expect(DEFAULT_WINDOW_HOURS).toBe(5)
    expect(DEFAULT_LIMIT_TOKENS).toBe(300_000)
    expect(LOW_QUOTA_PCT).toBe(10)
  })

  it("computeQuotaCost：搜索 200、+rerank 300、LLM 按真实 token、回退恒 0", () => {
    expect(computeQuotaCost()).toBe(200)
    expect(computeQuotaCost({ search: true })).toBe(200)
    expect(computeQuotaCost({ rerank: true })).toBe(300)
    expect(computeQuotaCost({ llmTokens: 1200 })).toBe(1400)
    expect(computeQuotaCost({ rerank: true, llmTokens: 1000 })).toBe(1300) // 200 + 100 + 1000
    expect(computeQuotaCost({ search: false })).toBe(0)
    expect(computeQuotaCost({ search: false, llmTokens: 800 })).toBe(800)
    // 回退优先级最高：即使带 rerank/LLM 也不扣
    expect(computeQuotaCost({ fallback: true, rerank: true, llmTokens: 100_000 })).toBe(0)
    // 非法 token 数忽略
    expect(computeQuotaCost({ llmTokens: -5 })).toBe(200)
    expect(computeQuotaCost({ llmTokens: Number.NaN })).toBe(200)
    expect(computeQuotaCost({ llmTokens: 12.9 })).toBe(212)
  })
})

describe("env 解析（QUOTA_WINDOW_TOKENS / QUOTA_WINDOW_HOURS）", () => {
  it("缺省 → 5h / 300000", () => {
    expect(windowHours()).toBe(5)
    expect(limitTokens()).toBe(300_000)
    expect(windowMs()).toBe(WINDOW_MS)
  })

  it("合法覆盖生效", () => {
    const env = { QUOTA_WINDOW_TOKENS: "1000", QUOTA_WINDOW_HOURS: "2" }
    expect(limitTokens(env)).toBe(1000)
    expect(windowHours(env)).toBe(2)
    expect(windowMs(env)).toBe(2 * HOUR_MS)
  })

  it("空串/非法/<=0 → 回默认（绝不 0 额度把自己锁死）", () => {
    for (const bad of ["", "abc", "0", "-5", "NaN"]) {
      expect(limitTokens({ QUOTA_WINDOW_TOKENS: bad })).toBe(300_000)
      expect(windowHours({ QUOTA_WINDOW_HOURS: bad })).toBe(5)
    }
  })
})

describe("usedPct / formatPct", () => {
  it("usedPct 按百分比四舍五入到 1 位并 clamp 到 [0,100]", () => {
    expect(usedPct(0, 300_000)).toBe(0)
    expect(usedPct(150_000, 300_000)).toBe(50)
    expect(usedPct(300_000, 300_000)).toBe(100)
    expect(usedPct(400_000, 300_000)).toBe(100)
    expect(usedPct(234, 1000)).toBe(23.4)
    expect(usedPct(1, 300_000)).toBe(0) // 0.0003% → 0
    expect(usedPct(-5, 1000)).toBe(0)
    expect(usedPct(100, 0)).toBe(0) // 非法上限不炸
    expect(usedPct(Number.NaN, 1000)).toBe(0)
  })

  it('formatPct(n) → "23.4%"（非法/越界安全）', () => {
    expect(formatPct(23.4)).toBe("23.4%")
    expect(formatPct(0)).toBe("0.0%")
    expect(formatPct(100)).toBe("100.0%")
    expect(formatPct(23.45)).toBe("23.5%")
    expect(formatPct(150)).toBe("100.0%")
    expect(formatPct(-5)).toBe("0.0%")
    expect(formatPct(Number.NaN)).toBe("0.0%")
  })
})

describe("getQuota（只读）", () => {
  it("窗口内：按已用/额度算百分比，remaining 与 used 相加为 100", async () => {
    const { db } = makeDb({ "acc-1": { period_start: NOW - HOUR_MS, used_cost: 60_000 } })
    const q = await getQuota(db, "acc-1", NOW)
    expect(q).toEqual({
      window_start: NOW - HOUR_MS,
      window_end: NOW - HOUR_MS + WINDOW_MS,
      window_hours: 5,
      limit_tokens: 300_000,
      used_tokens: 60_000,
      used_pct: 20,
      remaining_pct: 80,
      exceeded: false,
      reset_at: NOW - HOUR_MS + WINDOW_MS,
      reset_in_sec: 4 * 3600,
      degraded: false,
    })
  })

  it("网格推进后：视图按新窗口返回（used=0、window_start=网格起点），但**不改库**", async () => {
    // 注册于 NOW-6h → 网格起点 = NOW-6h + floor(6h/5h)*5h = NOW-1h
    const { db, rows } = makeDb(
      { "acc-1": { period_start: NOW - 6 * HOUR_MS, used_cost: 300_000 } },
      undefined,
      { "acc-1": NOW - 6 * HOUR_MS },
    )
    const q = await getQuota(db, "acc-1", NOW)
    expect(q.window_start).toBe(NOW - HOUR_MS)
    expect(q.window_end).toBe(NOW - HOUR_MS + WINDOW_MS)
    expect(q.reset_at).toBe(NOW - HOUR_MS + WINDOW_MS)
    expect(q.reset_in_sec).toBe(4 * 3600) // 网格起点 NOW-1h → 距重置 4h
    expect(q.used_tokens).toBe(0)
    expect(q.used_pct).toBe(0)
    expect(q.remaining_pct).toBe(100)
    expect(q.exceeded).toBe(false)
    // 库未动
    expect(rows.get("acc-1")!.period_start).toBe(NOW - 6 * HOUR_MS)
    expect(rows.get("acc-1")!.used_cost).toBe(300_000)
  })

  it("同窗口内错位（老 now 锚定数据）：起点按网格、**用量保留**、不改库", async () => {
    const { db, rows } = makeDb(
      { "acc-1": { period_start: NOW - HOUR_MS, used_cost: 60_000 } },
      undefined,
      { "acc-1": NOW - 3 * HOUR_MS }, // 网格起点 = NOW-3h，旧起点(NOW-1h)在同一网格窗口内
    )
    const q = await getQuota(db, "acc-1", NOW)
    expect(q.window_start).toBe(NOW - 3 * HOUR_MS)
    expect(q.used_tokens).toBe(60_000)
    expect(q.used_pct).toBe(20)
    expect(rows.get("acc-1")!.period_start).toBe(NOW - HOUR_MS) // 只读：不改库
  })

  it("恰好用尽 → exceeded=true、pct 100/0", async () => {
    const { db } = makeDb({ "acc-1": { period_start: NOW, used_cost: 300_000 } })
    const q = await getQuota(db, "acc-1", NOW)
    expect(q.exceeded).toBe(true)
    expect(q.used_pct).toBe(100)
    expect(q.remaining_pct).toBe(0)
  })

  it("超过额度（历史脏数据）→ pct clamp 到 100", async () => {
    const { db } = makeDb({ "acc-1": { period_start: NOW, used_cost: 900_000 } })
    const q = await getQuota(db, "acc-1", NOW)
    expect(q.used_pct).toBe(100)
    expect(q.remaining_pct).toBe(0)
    expect(q.exceeded).toBe(true)
  })

  it("env 覆盖额度：234/1000 → 23.4% / 76.6%", async () => {
    const { db } = makeDb({ "acc-1": { period_start: NOW, used_cost: 234 } })
    const q = await getQuota(db, "acc-1", NOW, { QUOTA_WINDOW_TOKENS: "1000" })
    expect(q.limit_tokens).toBe(1000)
    expect(q.used_pct).toBe(23.4)
    expect(q.remaining_pct).toBe(76.6)
    expect(q.exceeded).toBe(false)
  })

  it("缺 D1 / 无行 / D1 异常 → 放行视图（degraded=true，不抛错）", async () => {
    for (const db of [undefined, null]) {
      const q = await getQuota(db, "acc-1", NOW)
      expect(q.degraded).toBe(true)
      expect(q.used_tokens).toBe(0)
      expect(q.remaining_pct).toBe(100)
      expect(q.window_start).toBe(NOW)
    }
    const empty = makeDb()
    expect((await getQuota(empty.db, "nobody", NOW)).degraded).toBe(true)
    const broken = makeDb({}, "SELECT period_start")
    expect((await getQuota(broken.db, "acc-1", NOW)).degraded).toBe(true)
  })

  it("isLowQuota：剩余 < 10% 才提示", () => {
    const base: QuotaView = {
      window_start: NOW,
      window_end: NOW + WINDOW_MS,
      window_hours: 5,
      limit_tokens: 1000,
      used_tokens: 920,
      used_pct: 92,
      remaining_pct: 8,
      exceeded: false,
      reset_at: NOW + WINDOW_MS,
      reset_in_sec: 5 * 3600,
      degraded: false,
    }
    expect(isLowQuota(base)).toBe(true)
    expect(isLowQuota({ ...base, remaining_pct: 12 })).toBe(false)
    expect(isLowQuota({ ...base, remaining_pct: 10 })).toBe(false)
  })

  it("toQuotaResponse 投影给 SearchResponse.quota（只带百分比）", () => {
    const view: QuotaView = {
      window_start: NOW,
      window_end: NOW + WINDOW_MS,
      window_hours: 5,
      limit_tokens: 1000,
      used_tokens: 234,
      used_pct: 23.4,
      remaining_pct: 76.6,
      exceeded: false,
      reset_at: NOW + WINDOW_MS,
      reset_in_sec: 5 * 3600,
      degraded: false,
    }
    expect(toQuotaResponse(view)).toEqual({ used_pct: 23.4, remaining_pct: 76.6, fallback: false })
    expect(toQuotaResponse(view, true)).toEqual({ used_pct: 23.4, remaining_pct: 76.6, fallback: true })
  })
})

describe("gridWindowStart（按注册时间的网格锚定，纯函数）", () => {
  const CREATED = Date.UTC(2026, 8, 9, 7, 7, 0) // 注册于 07:07（UTC）→ 网格点 02:07/07:07/12:07/17:07/22:07

  it("常规值：窗口内任意时刻 → 同一个网格起点", () => {
    expect(gridWindowStart(CREATED, CREATED, WINDOW_MS)).toBe(CREATED)
    expect(gridWindowStart(CREATED, CREATED + 1, WINDOW_MS)).toBe(CREATED)
    expect(gridWindowStart(CREATED, CREATED + WINDOW_MS - 1, WINDOW_MS)).toBe(CREATED)
    expect(gridWindowStart(CREATED, CREATED + WINDOW_MS + 1, WINDOW_MS)).toBe(CREATED + WINDOW_MS)
    // 跨 3 天 2 小时 → 落在第 floor((74h)/5h)=14 个网格点
    const now = CREATED + 74 * HOUR_MS
    expect(gridWindowStart(CREATED, now, WINDOW_MS)).toBe(CREATED + 14 * WINDOW_MS)
    expect(gridWindowStart(CREATED, now, WINDOW_MS)).toBeLessThanOrEqual(now)
    expect(now - gridWindowStart(CREATED, now, WINDOW_MS)).toBeLessThan(WINDOW_MS)
  })

  it("恰好落在边界（now === createdAt + k*windowMs）→ **该边界**即新窗口起点", () => {
    for (const k of [1, 2, 3, 14]) {
      expect(gridWindowStart(CREATED, CREATED + k * WINDOW_MS, WINDOW_MS)).toBe(CREATED + k * WINDOW_MS)
    }
    // 边界前 1ms 仍是旧窗口
    expect(gridWindowStart(CREATED, CREATED + 2 * WINDOW_MS - 1, WINDOW_MS)).toBe(CREATED + WINDOW_MS)
  })

  it("createdAt > now（时钟回拨/脏数据）→ 回退 now（绝不产生负数或未来窗口）", () => {
    expect(gridWindowStart(NOW + HOUR_MS, NOW, WINDOW_MS)).toBe(NOW)
    expect(gridWindowStart(NOW + 1, NOW, WINDOW_MS)).toBe(NOW)
  })

  it("非法入参（windowMs<=0 / 非有限值）→ 回退 now", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(gridWindowStart(CREATED, NOW, bad)).toBe(NOW)
    }
    expect(gridWindowStart(Number.NaN, NOW, WINDOW_MS)).toBe(NOW)
    expect(gridWindowStart(Number.POSITIVE_INFINITY, NOW, WINDOW_MS)).toBe(NOW)
    expect(gridWindowStart(CREATED, Number.NaN, WINDOW_MS)).toBe(NaN) // now 本身非法 → 原样返回
  })

  it("自定义窗口（1h）与浮点窗口都稳定：起点 <= now < 起点+window", () => {
    const oneHour = HOUR_MS
    expect(gridWindowStart(CREATED, CREATED + 61 * 60_000, oneHour)).toBe(CREATED + oneHour)
    const floatSpan = 1.5 * HOUR_MS
    const start = gridWindowStart(CREATED, CREATED + 4 * HOUR_MS, floatSpan)
    expect(Number.isInteger(start)).toBe(true)
    expect(start).toBeLessThanOrEqual(CREATED + 4 * HOUR_MS)
    expect(start + floatSpan).toBeGreaterThan(CREATED + 4 * HOUR_MS)
  })
})

describe("ensureWindow（网格对齐 + 保证行存在）", () => {
  it("无行时补行：window_start = 网格起点（**不是 now**）、used=0", async () => {
    const { db, rows } = makeDb({}, undefined, { "acc-1": NOW - 6 * HOUR_MS })
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v).not.toBeNull()
    const gridStart = NOW - HOUR_MS // NOW-6h 的网格起点 = NOW-1h
    expect(rows.get("acc-1")).toEqual({
      period_start: gridStart,
      used_cost: 0,
      monthly_limit: 5,
      requests: 0,
      updated_at: NOW,
    })
    expect(v!.window_start).toBe(gridStart)
    expect(v!.reset_at).toBe(gridStart + WINDOW_MS)
  })

  it("已对齐网格 → 快路径不写库（2 次读：quotas + accounts）", async () => {
    // 注册于 NOW-1h → 网格起点 = NOW-1h，与库里 period_start 一致
    const { db, calls } = makeDb({ "acc-1": { period_start: NOW - HOUR_MS, used_cost: 60_000 } })
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v!.used_tokens).toBe(60_000)
    expect(v!.window_start).toBe(NOW - HOUR_MS)
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.sql).join("|")).toContain("SELECT created_at FROM accounts")
    expect(calls.some((c) => c.sql.startsWith("UPDATE") || c.sql.includes("INSERT"))).toBe(false)
  })

  it("网格推进（旧起点落后）→ used 归零、period_start = 网格起点", async () => {
    const { db, rows } = makeDb(
      { "acc-1": { period_start: NOW - WINDOW_MS, used_cost: 300_000 } },
      undefined,
      { "acc-1": NOW - 6 * HOUR_MS },
    )
    const v = await ensureWindow(db, "acc-1", NOW)
    const gridStart = NOW - HOUR_MS
    expect(v!.used_tokens).toBe(0)
    expect(v!.window_start).toBe(gridStart)
    expect(rows.get("acc-1")!.used_cost).toBe(0)
    expect(rows.get("acc-1")!.period_start).toBe(gridStart)
  })

  it("同窗口内错位（老 now 锚定数据）→ 对齐起点但**不清零**", async () => {
    const { db, rows } = makeDb(
      { "acc-1": { period_start: NOW - HOUR_MS, used_cost: 1234 } },
      undefined,
      { "acc-1": NOW - 3 * HOUR_MS }, // 网格起点 NOW-3h，旧起点 NOW-1h 仍在同一网格窗口
    )
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v!.window_start).toBe(NOW - 3 * HOUR_MS)
    expect(v!.used_tokens).toBe(1234)
    expect(rows.get("acc-1")!.used_cost).toBe(1234)
    expect(rows.get("acc-1")!.period_start).toBe(NOW - 3 * HOUR_MS)
  })

  it("网格窗口内任何时刻都对齐到**同一个**起点（重置时刻固定可预测）", async () => {
    const created = NOW - 6 * HOUR_MS // 网格点：...,NOW-6h,NOW-1h,NOW+4h
    const { db, rows } = makeDb({}, undefined, { "acc-1": created })
    const starts: number[] = []
    for (const t of [NOW, NOW + 1, NOW + HOUR_MS, NOW + 4 * HOUR_MS - 1]) {
      const v = await ensureWindow(db, "acc-1", t)
      starts.push(v!.window_start)
    }
    expect(new Set(starts).size).toBe(1)
    expect(starts[0]).toBe(NOW - HOUR_MS)
    // 跨过网格边界才推进
    expect((await ensureWindow(db, "acc-1", NOW + 4 * HOUR_MS))!.window_start).toBe(NOW + 4 * HOUR_MS)
    expect(rows.get("acc-1")!.used_cost).toBe(0)
  })

  it("并发 10 个请求跨窗口：只有一次清零，扣减的用量不会被抹掉", async () => {
    // 未对齐的旧行（落后于网格）：10 个并发 ensureWindow 必须只清一次
    const { db, rows } = makeDb(
      { "acc-1": { period_start: NOW - 10 * HOUR_MS, used_cost: 300_000 } },
      undefined,
      { "acc-1": NOW - 6 * HOUR_MS },
    )
    const views = await Promise.all(Array.from({ length: 10 }, () => ensureWindow(db, "acc-1", NOW)))
    expect(views.every((v) => v !== null)).toBe(true)
    expect(views.every((v) => v!.window_start === NOW - HOUR_MS)).toBe(true)
    expect(views.every((v) => v!.used_tokens === 0)).toBe(true)
    expect(rows.get("acc-1")!.used_cost).toBe(0)

    // 后到的并发请求（仍带着"旧起点"的时间片）不会二次清零：先扣 200，再并发对齐
    const charged = await chargeQuota(db, "acc-1", 200, NOW)
    expect(charged.ok).toBe(true)
    const late = await Promise.all([ensureWindow(db, "acc-1", NOW), ensureWindow(db, "acc-1", NOW)])
    expect(late.every((v) => v!.used_tokens === 200)).toBe(true)
    expect(rows.get("acc-1")!.used_cost).toBe(200)
  })

  it("并发扣减同窗口累计不丢（20 × 200 → 4000）", async () => {
    const { db, rows } = makeDb({}, undefined, { "acc-1": NOW - HOUR_MS })
    const results = await Promise.all(Array.from({ length: 20 }, () => chargeQuota(db, "acc-1", 200, NOW)))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(rows.get("acc-1")!.used_cost).toBe(4000)
  })

  it("accounts 行缺失 → 以 now 为锚（不抛错），视图 degraded=true 可见", async () => {
    const { db, rows } = makeDb({ "acc-1": { period_start: NOW - 10 * HOUR_MS, used_cost: 500 } }, undefined, {
      "acc-1": null,
    })
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v).not.toBeNull()
    expect(v!.window_start).toBe(NOW) // 回退 now 锚
    expect(v!.degraded).toBe(true)
    expect(rows.get("acc-1")!.period_start).toBe(NOW)
    expect(rows.get("acc-1")!.used_cost).toBe(0) // 回退锚会清零（无法判断是否跨窗口，保守从新窗口起算）
  })

  it("accounts.created_at 非法（NaN）→ 同样回退 now 锚", async () => {
    const { db } = makeDb({ "acc-1": { period_start: NOW, used_cost: 100 } }, undefined, { "acc-1": Number.NaN })
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v!.window_start).toBe(NOW)
    expect(v!.used_tokens).toBe(100) // 同窗口错位（起点相等）→ 快路径，用量保留
    expect(v!.degraded).toBe(true)
  })

  it("env 自定义窗口（1h）网格生效", async () => {
    const env = { QUOTA_WINDOW_HOURS: "1" }
    // 注册于 NOW-30min → 1h 网格起点 = NOW-30min（与库里一致 → 保留用量）
    const fresh = makeDb({ "acc-1": { period_start: NOW - 30 * 60_000, used_cost: 500 } })
    expect((await ensureWindow(fresh.db, "acc-1", NOW, env))!.used_tokens).toBe(500)
    expect((await ensureWindow(fresh.db, "acc-1", NOW, env))!.window_start).toBe(NOW - 30 * 60_000)
    // 注册于 NOW-90min → 1h 网格起点 = NOW-30min；旧起点 NOW-90min 落后 → 清零
    const stale = makeDb({ "acc-1": { period_start: NOW - 90 * 60_000, used_cost: 500 } }, undefined, {
      "acc-1": NOW - 90 * 60_000,
    })
    const v = await ensureWindow(stale.db, "acc-1", NOW, env)
    expect(v!.used_tokens).toBe(0)
    expect(v!.window_start).toBe(NOW - 30 * 60_000)
    expect(v!.window_end).toBe(NOW + 30 * 60_000)
  })

  it("缺 D1 → null（不抛错）", async () => {
    expect(await ensureWindow(undefined, "acc-1", NOW)).toBeNull()
    expect(await ensureWindow(null, "acc-1", NOW)).toBeNull()
  })

  it("accounts 读抛错 → null（吞掉异常，绝不让配额读崩掉检索）", async () => {
    const { db } = makeDb({ "acc-1": {} }, "SELECT created_at FROM accounts")
    expect(await ensureWindow(db, "acc-1", NOW)).toBeNull()
  })
})

describe("配额视图的重置字段（R6：window_end / reset_at / reset_in_sec）", () => {
  it("三字段数值正确、reset_at === window_end、reset_in_sec 恒 >= 0", async () => {
    const { db } = makeDb({ "acc-1": { period_start: NOW - HOUR_MS, used_cost: 1000 } })
    const q = await getQuota(db, "acc-1", NOW)
    expect(q.window_end).toBe(q.window_start + q.window_hours * HOUR_MS)
    expect(q.reset_at).toBe(q.window_end)
    expect(q.reset_in_sec).toBe(Math.max(0, Math.ceil((q.window_end - NOW) / 1000)))
    expect(q.reset_in_sec).toBeGreaterThanOrEqual(0)
  })

  it("窗口末尾：reset_in_sec 归 1s、不为负；边界时刻网格推进 → 新窗口从满额起算", async () => {
    const { db } = makeDb({ "acc-1": { period_start: NOW, used_cost: 1000 } })
    const end = NOW + WINDOW_MS
    const before = await getQuota(db, "acc-1", end - 1)
    expect(before.reset_in_sec).toBe(1)
    expect(before.used_tokens).toBe(1000)
    // now 恰在网格边界 → 网格起点 = now（新窗口），reset_in_sec = 整个窗口
    const atEnd = await getQuota(db, "acc-1", end)
    expect(atEnd.window_start).toBe(end)
    expect(atEnd.window_end).toBe(end + WINDOW_MS)
    expect(atEnd.reset_in_sec).toBe(5 * 3600)
    expect(atEnd.used_tokens).toBe(0) // 网格推进 → 用量归零
    // 时钟回拨（now 早于行里的起点）→ reset_in_sec 绝不为负
    const rewound = await getQuota(db, "acc-1", NOW - 10 * HOUR_MS)
    expect(rewound.reset_in_sec).toBeGreaterThanOrEqual(0)
  })

  it("跨窗口后（ensureWindow 落库）视图用量归零、reset 指向下一网格点", async () => {
    const created = NOW - 6 * HOUR_MS
    const { db } = makeDb({ "acc-1": { period_start: NOW - HOUR_MS, used_cost: 299_800 } }, undefined, {
      "acc-1": created,
    })
    await chargeQuota(db, "acc-1", 400, NOW) // 窗口内累计到 300200 → 超额
    const after = await getQuota(db, "acc-1", NOW + 4 * HOUR_MS)
    expect(after.window_start).toBe(NOW + 4 * HOUR_MS)
    expect(after.used_tokens).toBe(0)
    expect(after.reset_at).toBe(NOW + 9 * HOUR_MS)
    expect(after.reset_in_sec).toBe(5 * 3600)
    expect(after.remaining_pct).toBe(100)
  })

  it("env 覆盖窗口长度时 window_end / reset_at 跟着变", async () => {
    const env = { QUOTA_WINDOW_HOURS: "2" }
    const { db } = makeDb({ "acc-1": { period_start: NOW - HOUR_MS, used_cost: 0 } })
    const q = await getQuota(db, "acc-1", NOW, env)
    expect(q.window_end).toBe(q.window_start + 2 * HOUR_MS)
    expect(q.reset_in_sec).toBe(3600)
  })

  it("降级视图也带三字段（不因缺失/异常而 undefined）", async () => {
    const q = await getQuota(undefined, "acc-1", NOW)
    expect(q.degraded).toBe(true)
    expect(q.window_end).toBe(NOW + WINDOW_MS)
    expect(q.reset_at).toBe(q.window_end)
    expect(q.reset_in_sec).toBe(5 * 3600)
  })
})

describe("chargeQuota（原子扣减）", () => {
  it("扣减成功：200 tokens → used 200、0.1%", async () => {
    const { db, rows } = makeDb({ "acc-1": {} })
    const res = await chargeQuota(db, "acc-1", 200, NOW)
    expect(res.ok).toBe(true)
    expect(res.used_tokens).toBe(200)
    expect(res.used_pct).toBe(0.1) // 200/300000 = 0.0667% → 0.1
    expect(res.remaining_pct).toBe(99.9)
    expect(res.reason).toBeUndefined()
    expect(rows.get("acc-1")!.used_cost).toBe(200)
  })

  it("窗口内累计", async () => {
    const { db, rows } = makeDb({ "acc-1": {} })
    await chargeQuota(db, "acc-1", 200, NOW)
    await chargeQuota(db, "acc-1", 300, NOW)
    const third = await chargeQuota(db, "acc-1", 500, NOW)
    expect(third.used_tokens).toBe(1000)
    expect(rows.get("acc-1")!.used_cost).toBe(1000)
  })

  it("用的是单条原子条件 UPDATE（判-扣合一，防超卖）", async () => {
    const { db, calls } = makeDb({ "acc-1": {} })
    await chargeQuota(db, "acc-1", 200, NOW)
    const sql = calls.map((c) => c.sql).join("\n")
    expect(sql).toContain("used_cost = used_cost + ?")
    expect(sql).toContain("used_cost + ? <= ?")
  })

  // ── 技术债 #4：requests（本窗口扣费成功的真实请求数）──
  it("requests 与 used_cost 在**同一条** UPDATE 里自增（零额外写）", async () => {
    const { db, calls } = makeDb({ "acc-1": {} })
    await chargeQuota(db, "acc-1", 200, NOW)
    const chargeCalls = calls.filter((c) => c.sql.includes("used_cost = used_cost + ?"))
    expect(chargeCalls).toHaveLength(1)
    expect(chargeCalls[0].sql).toContain("requests = requests + 1")
    // 绑定参数顺序不变（cost 绑定两次：累加 + 判额）
    expect(chargeCalls[0].args).toEqual([200, NOW, "acc-1", 200, DEFAULT_LIMIT_TOKENS])
  })

  it("每次扣费成功 requests +1；退还/零消耗/getQuota 都不涨", async () => {
    const { db, rows } = makeDb({ "acc-1": {} })
    await chargeQuota(db, "acc-1", 200, NOW)
    await chargeQuota(db, "acc-1", 200, NOW)
    expect(rows.get("acc-1")!.requests).toBe(2)
    // cost=0（回退/免费）不写库 → 不涨
    await chargeQuota(db, "acc-1", 0, NOW)
    expect(rows.get("acc-1")!.requests).toBe(2)
    // 只读视图不涨
    await getQuota(db, "acc-1", NOW)
    expect(rows.get("acc-1")!.requests).toBe(2)
    // 管理员加额（grantQuota）不涨
    await grantQuota(db, "acc-1", 100, NOW)
    expect(rows.get("acc-1")!.requests).toBe(2)
  })

  it("超额那一击**不**计入 requests（判额失败 = 整条语句不改任何列）", async () => {
    const { db, rows } = makeDb({ "acc-1": { used_cost: 300_000 } }) // 已用满
    const res = await chargeQuota(db, "acc-1", 200, NOW)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("quota-exceeded")
    expect(rows.get("acc-1")!.requests).toBe(0)
    expect(rows.get("acc-1")!.used_cost).toBe(300_000)
  })

  it("窗口切换 → requests 与本窗口用量一起清零（⓪ 清零语句在网格推进之前）", async () => {
    // 上一窗口：用过 500、请求 3 次；现在跨到下一网格窗口
    const { db, rows, calls } = makeDb({ "acc-1": { used_cost: 500, requests: 3, period_start: NOW - WINDOW_MS } })
    await chargeQuota(db, "acc-1", 200, NOW)
    expect(rows.get("acc-1")!.used_cost).toBe(200) // 旧窗口用量已清零，只剩本次
    expect(rows.get("acc-1")!.requests).toBe(1) // 旧窗口的 3 次已清零，只剩本次
    const sqls = calls.map((c) => c.sql)
    const resetIdx = sqls.findIndex((q) => q.includes("SET requests = 0"))
    const advanceIdx = sqls.findIndex((q) => q.includes("used_cost = 0") && q.includes("AND period_start < ?"))
    expect(resetIdx).toBeGreaterThanOrEqual(0)
    expect(advanceIdx).toBeGreaterThan(resetIdx) // 顺序不能反：先把旧窗口清零，再推进窗口
  })

  it("同窗口内不清零：对齐语句的 `period_start < gridStart` 条件不成立 → requests 用量保留", async () => {
    const { db, rows } = makeDb({ "acc-1": { used_cost: 300, requests: 2 } })
    await chargeQuota(db, "acc-1", 200, NOW)
    // 性能优化后，"清零 requests"这条语句**始终在 batch 里**（省不掉，否则跨窗口时来不及清），
    // 但仍靠 SQL 里的条件 `period_start < gridStart` 保证同窗口内 0 行受影响 —— 断言**效果**而非语句存在性。
    expect(rows.get("acc-1")!.requests).toBe(3) // 旧值 2 + 本次 1（没被清零）
    expect(rows.get("acc-1")!.used_cost).toBe(500) // 旧值 300 + 本次 200（没被清零）
    expect(rows.get("acc-1")!.period_start).toBe(NOW) // 窗口起点没动
  })

  it("真故障（非缺列）→ 不做 legacy 重跑（避免 batch 未回滚时重复扣费），直接 fail-open", async () => {
    // 扣费语句抛"网络/限流"这类真错误：**不该**再跑一次不带 requests 的语句（那可能重复扣费）
    const { db, rows, calls } = makeDb({ "acc-1": {} }, "used_cost = used_cost + ?")
    const res = await chargeQuota(db, "acc-1", 200, NOW)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("db-unavailable")
    expect(calls.filter((c) => c.sql.includes("used_cost = used_cost + ?")).length).toBe(1) // 只尝试过一次
    expect(rows.get("acc-1")!.used_cost).toBe(0)
  })

  it("旧库（还没跑 apply-schema，没有 requests 列）→ 退化为旧语句，配额照常扣、不 fail-open", async () => {
    const { db, rows, calls } = makeDb({ "acc-1": {} }, undefined, undefined, true /* noRequestsColumn */)
    const res = await chargeQuota(db, "acc-1", 200, NOW)
    expect(res.ok).toBe(true) // 关键：不能因为缺列就判 db-unavailable（那会让额度形同虚设）
    expect(res.reason).toBeUndefined()
    expect(rows.get("acc-1")!.used_cost).toBe(200)
    expect(rows.get("acc-1")!.requests).toBe(0) // 迁移完成前 requests 恒 0（在 /admin/usage 上可见）
    // 两条语句都发了：先带 requests（失败），再退化
    expect(calls.filter((c) => c.sql.includes("used_cost = used_cost + ?")).length).toBe(2)
    expect(calls.filter((c) => c.sql.includes("requests")).length).toBeGreaterThan(0)
  })

  it("旧库 + 窗口切换：缺列不影响窗口推进与扣费（清零语句失败被吞）", async () => {
    const { db, rows } = makeDb(
      { "acc-1": { used_cost: 500, requests: 3, period_start: NOW - WINDOW_MS } },
      undefined,
      undefined,
      true,
    )
    const res = await chargeQuota(db, "acc-1", 200, NOW)
    expect(res.ok).toBe(true)
    expect(rows.get("acc-1")!.used_cost).toBe(200)
  })

  it("超额 → {ok:false, reason:'quota-exceeded'}（不抛错、不扣）", async () => {
    const { db, rows } = makeDb({ "acc-1": { used_cost: 299_900 } })
    const res = await chargeQuota(db, "acc-1", 200, NOW)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("quota-exceeded")
    expect(res.used_tokens).toBe(299_900)
    expect(res.used_pct).toBe(100) // 99.9667% 四舍五入到 100.0
    expect(res.remaining_pct).toBe(0)
    expect(rows.get("acc-1")!.used_cost).toBe(299_900)
  })

  it("恰好用尽：299800+200=300000 允许，下一次被拒", async () => {
    const { db, rows } = makeDb({ "acc-1": { used_cost: 299_800 } })
    const last = await chargeQuota(db, "acc-1", 200, NOW)
    expect(last.ok).toBe(true)
    expect(last.used_tokens).toBe(300_000)
    expect(last.used_pct).toBe(100)
    expect(last.remaining_pct).toBe(0)
    const denied = await chargeQuota(db, "acc-1", 200, NOW)
    expect(denied.ok).toBe(false)
    expect(denied.reason).toBe("quota-exceeded")
    expect(rows.get("acc-1")!.used_cost).toBe(300_000)
  })

  it("并发 20 次无超卖（额度 1000，每次 200 → 恰好 5 成功）", async () => {
    const { db, rows } = makeDb({ "acc-1": {} })
    const env = { QUOTA_WINDOW_TOKENS: "1000" }
    const results = await Promise.all(Array.from({ length: 20 }, () => chargeQuota(db, "acc-1", 200, NOW, env)))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(results.filter((r) => !r.ok && r.reason === "quota-exceeded")).toHaveLength(15)
    expect(rows.get("acc-1")!.used_cost).toBe(1000)
  })

  it("跨窗口：上一窗口已用满，本次自动开新窗口（网格起点）并成功", async () => {
    const { db, rows } = makeDb(
      { "acc-1": { period_start: NOW - 6 * HOUR_MS, used_cost: 300_000 } },
      undefined,
      { "acc-1": NOW - 6 * HOUR_MS },
    )
    const res = await chargeQuota(db, "acc-1", 200, NOW)
    expect(res.ok).toBe(true)
    expect(res.used_tokens).toBe(200)
    expect(rows.get("acc-1")!.period_start).toBe(NOW - HOUR_MS) // 网格起点，不再是 now
    expect(rows.get("acc-1")!.used_cost).toBe(200)
    expect(res.used_pct).toBe(0.1)
  })

  it("env 额度生效：1000 token 额度下第 6 次 200 被拒", async () => {
    const { db } = makeDb({ "acc-1": {} })
    const env = { QUOTA_WINDOW_TOKENS: "1000" }
    for (let i = 0; i < 5; i++) {
      expect((await chargeQuota(db, "acc-1", 200, NOW, env)).ok).toBe(true)
    }
    const denied = await chargeQuota(db, "acc-1", 200, NOW, env)
    expect(denied.ok).toBe(false)
    expect(denied.reason).toBe("quota-exceeded")
  })

  it("零/负数消耗（回退）不写库，但仍回报窗口状态", async () => {
    const { db, calls } = makeDb({ "acc-1": { used_cost: 5000 } })
    for (const t of [0, -100, Number.NaN]) {
      const res = await chargeQuota(db, "acc-1", t, NOW)
      expect(res.ok).toBe(true)
      expect(res.used_tokens).toBe(5000)
    }
    expect(calls.some((c) => c.sql.includes("used_cost = used_cost +"))).toBe(false)
  })

  it("缺 D1 → {ok:false, reason:'db-unavailable'}（不抛错）", async () => {
    for (const db of [undefined, null]) {
      const res = await chargeQuota(db, "acc-1", 200, NOW)
      expect(res).toEqual({ ok: false, used_tokens: 0, used_pct: 0, remaining_pct: 100, reason: "db-unavailable" })
    }
    expect((await chargeQuota(makeDb().db, "", 200, NOW)).reason).toBe("db-unavailable")
  })

  it("D1 抛错 → db-unavailable（吞掉异常）", async () => {
    const onCharge = makeDb({ "acc-1": {} }, "used_cost = used_cost + ?")
    expect((await chargeQuota(onCharge.db, "acc-1", 200, NOW)).reason).toBe("db-unavailable")
    const onSelect = makeDb({ "acc-1": {} }, "SELECT period_start")
    expect((await chargeQuota(onSelect.db, "acc-1", 200, NOW)).reason).toBe("db-unavailable")
  })
})

describe("管理员加额 / 扣额 / 重置（T3.3 admin）", () => {
  it("grantQuota(+50000) 释放额度：used 60000 → 10000", async () => {
    const { db, rows } = makeDb({ "acc-1": { used_cost: 60_000 } })
    const v = await grantQuota(db, "acc-1", 50_000, NOW)
    expect(v!.used_tokens).toBe(10_000)
    expect(v!.used_pct).toBe(3.3)
    expect(rows.get("acc-1")!.used_cost).toBe(10_000)
  })

  it("加额超过已用量 → 夹到 0（不会变负）", async () => {
    const { db, rows } = makeDb({ "acc-1": { used_cost: 1000 } })
    const v = await grantQuota(db, "acc-1", 999_999, NOW)
    expect(v!.used_tokens).toBe(0)
    expect(v!.remaining_pct).toBe(100)
    expect(rows.get("acc-1")!.used_cost).toBe(0)
  })

  it("负值扣额：used 增加并夹到上限", async () => {
    const { db, rows } = makeDb({ "acc-1": { used_cost: 900 } })
    const v = await grantQuota(db, "acc-1", -500, NOW, { QUOTA_WINDOW_TOKENS: "1000" })
    expect(v!.used_tokens).toBe(1000)
    expect(v!.exceeded).toBe(true)
    expect(rows.get("acc-1")!.used_cost).toBe(1000)
  })

  it("delta 0 / 非法值 → 只读不改", async () => {
    const { db, calls } = makeDb({ "acc-1": { used_cost: 500 } })
    await grantQuota(db, "acc-1", 0, NOW)
    await grantQuota(db, "acc-1", Number.NaN, NOW)
    expect(calls.some((c) => c.sql.includes("MIN(?, MAX(0.0"))).toBe(false)
  })

  it("缺 D1 → null（不抛错）", async () => {
    expect(await grantQuota(undefined, "acc-1", 100, NOW)).toBeNull()
    expect(await grantQuota(null, "acc-1", 100, NOW)).toBeNull()
  })

  it("D1 抛错 → null（吞掉异常）", async () => {
    const { db } = makeDb({ "acc-1": {} }, "MIN(?, MAX(0.0")
    expect(await grantQuota(db, "acc-1", 100, NOW)).toBeNull()
  })

  it("resetQuota 清空当前窗口，窗口起点 = 当前网格起点（不是 now）", async () => {
    // 注册于 NOW-3h → 网格起点 NOW-3h；旧起点 NOW-2h 在同一网格窗口内 → 对齐到 NOW-3h
    const { db, rows } = makeDb({ "acc-1": { period_start: NOW - 2 * HOUR_MS, used_cost: 250_000 } }, undefined, {
      "acc-1": NOW - 3 * HOUR_MS,
    })
    const v = await resetQuota(db, "acc-1", NOW)
    expect(v!.used_tokens).toBe(0)
    expect(v!.window_start).toBe(NOW - 3 * HOUR_MS)
    expect(v!.remaining_pct).toBe(100)
    expect(rows.get("acc-1")!.used_cost).toBe(0)
    expect(rows.get("acc-1")!.period_start).toBe(NOW - 3 * HOUR_MS)
  })

  it("resetQuota **不改变**重置时刻：重置前后 reset_at 一致（R6 核心不变式）", async () => {
    const created = NOW - 6 * HOUR_MS // 网格点 ...,NOW-1h,NOW+4h
    const { db } = makeDb({ "acc-1": { period_start: NOW - HOUR_MS, used_cost: 300_000 } }, undefined, {
      "acc-1": created,
    })
    const before = await getQuota(db, "acc-1", NOW)
    const after = await resetQuota(db, "acc-1", NOW)
    expect(before.reset_at).toBe(NOW + 4 * HOUR_MS)
    expect(after!.reset_at).toBe(before.reset_at)
    expect(after!.window_start).toBe(before.window_start)
    expect(after!.used_tokens).toBe(0)
    expect(after!.exceeded).toBe(false)
  })

  it("resetQuota 缺 D1 → null（不抛错）", async () => {
    expect(await resetQuota(undefined, "acc-1", NOW)).toBeNull()
    expect(await resetQuota(null, "acc-1", NOW)).toBeNull()
  })
})

describe("密钥/隐私回归", () => {
  it("所有写入参数中不出现任何 key 形状的字符串", async () => {
    const { db, calls } = makeDb({ "acc-1": {} })
    await chargeQuota(db, "acc-1", 200, NOW)
    await grantQuota(db, "acc-1", 100, NOW)
    await resetQuota(db, "acc-1", NOW)
    const flat = calls.flatMap((c) => c.args.map((a) => String(a))).join("|")
    expect(flat).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(flat.toLowerCase()).not.toContain("bearer")
  })

  it("降级路径不打印任何参数", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { db } = makeDb({ "acc-1": {} }, "used_cost = used_cost + ?")
    await chargeQuota(db, "acc-1", 200, NOW)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
