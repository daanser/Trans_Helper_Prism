// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 配额计量与原子扣减单测（tasks.md T3.2，滚动 5h 窗口 + 加权 token 模型）
// 全 mock：D1 用内存假表实现「条件 UPDATE + meta.changes」语义，零网络、零真实 key。
// 重点：① 窗口内累计；② 跨 5h 自动开新窗口；③ 并发不超卖；④ 超额不抛错只回 reason；
//       ⑤ used_pct 计算与 clamp；⑥ env 缺失/非法回默认值；⑦ 缺 D1 优雅降级。
import { describe, it, expect, vi } from "vitest"
import {
  QUOTA_COST,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_LIMIT_TOKENS,
  LOW_QUOTA_PCT,
  windowHours,
  windowMs,
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
  updated_at: number
}

/**
 * 内存 D1 假表：按 SQL 形状识别语句，实现与 quota.ts 完全一致的语义
 * （特别是条件 UPDATE 的 meta.changes 判定）。遇到未识别 SQL 直接抛错，防止实现漂移后测试静默通过。
 */
function makeDb(seed: Record<string, Partial<FakeRow>> = {}, failOn?: string) {
  const rows = new Map<string, FakeRow>()
  for (const [id, r] of Object.entries(seed)) {
    rows.set(id, {
      period_start: r.period_start ?? NOW,
      used_cost: r.used_cost ?? 0,
      monthly_limit: r.monthly_limit ?? 5,
      updated_at: r.updated_at ?? NOW,
    })
  }
  const calls: Array<{ sql: string; args: unknown[] }> = []

  const apply = (sql: string, args: unknown[]): number => {
    if (sql.includes("INSERT OR IGNORE INTO quotas")) {
      const [accountId, windowStart, legacyLimit, updatedAt] = args as [string, number, number, number]
      if (rows.has(accountId)) return 0
      rows.set(accountId, { period_start: windowStart, used_cost: 0, monthly_limit: legacyLimit, updated_at: updatedAt })
      return 1
    }
    if (sql.includes("AND period_start <= ?")) {
      // ensureWindow 窗口推进
      const [windowStart, updatedAt, accountId, threshold] = args as [number, number, string, number]
      const row = rows.get(accountId)
      if (!row || !(row.period_start <= threshold)) return 0
      row.used_cost = 0
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
    if (sql.includes("SET used_cost = 0, period_start = ?")) {
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

  return { db, rows, calls }
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
      window_hours: 5,
      limit_tokens: 300_000,
      used_tokens: 60_000,
      used_pct: 20,
      remaining_pct: 80,
      exceeded: false,
      degraded: false,
    })
  })

  it("窗口过期：视图按新窗口返回（used=0、window_start=now），但**不改库**", async () => {
    const { db, rows } = makeDb({ "acc-1": { period_start: NOW - 6 * HOUR_MS, used_cost: 300_000 } })
    const q = await getQuota(db, "acc-1", NOW)
    expect(q.window_start).toBe(NOW)
    expect(q.used_tokens).toBe(0)
    expect(q.used_pct).toBe(0)
    expect(q.remaining_pct).toBe(100)
    expect(q.exceeded).toBe(false)
    // 库未动
    expect(rows.get("acc-1")!.period_start).toBe(NOW - 6 * HOUR_MS)
    expect(rows.get("acc-1")!.used_cost).toBe(300_000)
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
      window_hours: 5,
      limit_tokens: 1000,
      used_tokens: 920,
      used_pct: 92,
      remaining_pct: 8,
      exceeded: false,
      degraded: false,
    }
    expect(isLowQuota(base)).toBe(true)
    expect(isLowQuota({ ...base, remaining_pct: 12 })).toBe(false)
    expect(isLowQuota({ ...base, remaining_pct: 10 })).toBe(false)
  })

  it("toQuotaResponse 投影给 SearchResponse.quota（只带百分比）", () => {
    const view: QuotaView = {
      window_start: NOW,
      window_hours: 5,
      limit_tokens: 1000,
      used_tokens: 234,
      used_pct: 23.4,
      remaining_pct: 76.6,
      exceeded: false,
      degraded: false,
    }
    expect(toQuotaResponse(view)).toEqual({ used_pct: 23.4, remaining_pct: 76.6, fallback: false })
    expect(toQuotaResponse(view, true)).toEqual({ used_pct: 23.4, remaining_pct: 76.6, fallback: true })
  })
})

describe("ensureWindow（滚动窗口推进）", () => {
  it("无行时补行（window_start=now、used=0）", async () => {
    const { db, rows } = makeDb()
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v).not.toBeNull()
    expect(rows.get("acc-1")).toEqual({ period_start: NOW, used_cost: 0, monthly_limit: 5, updated_at: NOW })
  })

  it("窗口未过期 → 快路径不写库（只 1 次 SELECT）", async () => {
    const { db, calls } = makeDb({ "acc-1": { period_start: NOW - HOUR_MS, used_cost: 60_000 } })
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v!.used_tokens).toBe(60_000)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain("SELECT period_start")
  })

  it("窗口过期（>= 5h）→ used 归零、window_start=now", async () => {
    const { db, rows } = makeDb({ "acc-1": { period_start: NOW - WINDOW_MS, used_cost: 300_000 } })
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v!.used_tokens).toBe(0)
    expect(v!.window_start).toBe(NOW)
    expect(rows.get("acc-1")!.used_cost).toBe(0)
    expect(rows.get("acc-1")!.period_start).toBe(NOW)
  })

  it("差 1ms 未满 5h → 不重置", async () => {
    const { db, rows } = makeDb({ "acc-1": { period_start: NOW - WINDOW_MS + 1, used_cost: 1234 } })
    const v = await ensureWindow(db, "acc-1", NOW)
    expect(v!.used_tokens).toBe(1234)
    expect(rows.get("acc-1")!.used_cost).toBe(1234)
  })

  it("env 自定义窗口（1h）生效", async () => {
    const env = { QUOTA_WINDOW_HOURS: "1" }
    const fresh = makeDb({ "acc-1": { period_start: NOW - 30 * 60_000, used_cost: 500 } })
    expect((await ensureWindow(fresh.db, "acc-1", NOW, env))!.used_tokens).toBe(500)
    const stale = makeDb({ "acc-1": { period_start: NOW - 61 * 60_000, used_cost: 500 } })
    expect((await ensureWindow(stale.db, "acc-1", NOW, env))!.used_tokens).toBe(0)
  })

  it("缺 D1 → null（不抛错）", async () => {
    expect(await ensureWindow(undefined, "acc-1", NOW)).toBeNull()
    expect(await ensureWindow(null, "acc-1", NOW)).toBeNull()
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

  it("跨窗口：上一窗口已用满，本次自动开新窗口并成功", async () => {
    const { db, rows } = makeDb({ "acc-1": { period_start: NOW - 6 * HOUR_MS, used_cost: 300_000 } })
    const res = await chargeQuota(db, "acc-1", 200, NOW)
    expect(res.ok).toBe(true)
    expect(res.used_tokens).toBe(200)
    expect(rows.get("acc-1")!.period_start).toBe(NOW)
    expect(rows.get("acc-1")!.used_cost).toBe(200)
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

  it("resetQuota 清空当前窗口并重置窗口起点", async () => {
    const { db, rows } = makeDb({ "acc-1": { period_start: NOW - 2 * HOUR_MS, used_cost: 250_000 } })
    const v = await resetQuota(db, "acc-1", NOW)
    expect(v!.used_tokens).toBe(0)
    expect(v!.window_start).toBe(NOW)
    expect(v!.remaining_pct).toBe(100)
    expect(rows.get("acc-1")!.used_cost).toBe(0)
    expect(rows.get("acc-1")!.period_start).toBe(NOW)
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
