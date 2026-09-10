// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — D1 原子分档计数单测（plan-ratelimit.md §5）
// 全 mock：D1 用内存假表实现「条件 UPDATE + meta.changes」语义，零网络、零真实密钥。
// 重点：① 窗口内累加 / 跨窗口重置；② **并发 20 次不超卖**（limit=5 → 恰好 5 成功）；
//       ③ D1 异常 fail-open + degraded；④ 过期行清理；⑤ **bucket_key 不含 IP 明文**（隐私验收项）；
//       ⑥ HMAC 键来源（不新增 secret，未配置时退化）。
import { describe, it, expect } from "vitest"
import {
  RATE_LIMIT_HMAC_KEY_FALLBACK,
  bucketKeyFor,
  consumeRateToken,
  deriveRateLimitHmacKey,
  hmacSha256Hex,
  isDegradedHmacKey,
  peekRateCount,
  purgeExpiredCounters,
  readBlockUntil,
  retryAfterSecFor,
  sha256Hex,
  windowIndex,
  windowStart,
  writeBlockUntil,
} from "../src/ratecount"

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0)
const IP_A = "203.0.113.7"
const IP_B = "198.51.100.9"

interface FakeRow {
  bucket_key: string
  tier: string
  window_start: number
  window_sec: number
  count: number
  updated_at: number
}

/**
 * 内存 D1 假表：按 SQL 形状识别语句，实现与 ratecount.ts 完全一致的语义
 * （特别是条件 UPDATE 的 meta.changes 判定 —— 并发不超卖的**唯一**依据）。
 * 遇到未识别 SQL 直接抛错，防止实现漂移后测试静默通过。
 */
function makeDb(opts: { failOn?: string } = {}) {
  const rows = new Map<string, FakeRow>()
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const failOn = opts.failOn

  const apply = (sql: string, args: unknown[]): number => {
    if (sql.includes("INSERT OR IGNORE INTO rate_counters")) {
      // 两条 INSERT 形状不同：consume 的 count 写死 0（5 个占位符），block 的 count 是参数（6 个）
      if (sql.includes("VALUES (?, ?, ?, ?, ?, ?)")) {
        const [bucketKey, tier, windowStartV, windowSec, count, updatedAt] = args as [
          string,
          string,
          number,
          number,
          number,
          number,
        ]
        if (rows.has(bucketKey)) return 0
        rows.set(bucketKey, {
          bucket_key: bucketKey,
          tier,
          window_start: windowStartV,
          window_sec: windowSec,
          count,
          updated_at: updatedAt,
        })
        return 1
      }
      const [bucketKey, tier, windowStartV, windowSec, updatedAt] = args as [string, string, number, number, number]
      if (rows.has(bucketKey)) return 0
      rows.set(bucketKey, {
        bucket_key: bucketKey,
        tier,
        window_start: windowStartV,
        window_sec: windowSec,
        count: 0,
        updated_at: updatedAt,
      })
      return 1
    }
    if (sql.includes("count = count + 1")) {
      // consumeRateToken：单条原子「判-占」
      const [updatedAt, bucketKey, limit] = args as [number, string, number]
      const row = rows.get(bucketKey)
      if (!row) return 0
      if (row.count >= limit) return 0
      row.count += 1
      row.updated_at = updatedAt
      return 1
    }
    if (sql.startsWith("UPDATE rate_counters SET count = ?")) {
      // writeBlockUntil
      const [count, windowStartV, windowSec, updatedAt, bucketKey] = args as [number, number, number, number, string]
      const row = rows.get(bucketKey)
      if (!row) return 0
      row.count = count
      row.window_start = windowStartV
      row.window_sec = windowSec
      row.updated_at = updatedAt
      return 1
    }
    if (sql.startsWith("DELETE FROM rate_counters")) {
      const [threshold, batch] = args as [number, number]
      const victims = [...rows.values()].filter((r) => r.window_start < threshold).slice(0, batch)
      for (const v of victims) rows.delete(v.bucket_key)
      return victims.length
    }
    throw new Error(`unhandled-sql: ${sql}`)
  }

  const db = {
    prepare(sql: string) {
      const rec = { sql, args: [] as unknown[] }
      const boom = () => {
        if (failOn && sql.includes(failOn)) throw new Error("d1-failed")
      }
      const stmt = {
        bind(...args: unknown[]) {
          rec.args = args
          calls.push(rec)
          return stmt
        },
        async first() {
          boom()
          if (!sql.includes("SELECT count FROM rate_counters")) return null
          const row = rows.get(String(rec.args[0]))
          return row ? { count: row.count } : null
        },
        async run() {
          boom()
          return { success: true, results: [], meta: { changes: apply(sql, rec.args) } }
        },
      }
      return stmt
    },
  } as unknown as D1Database

  return { db, rows, calls }
}

/** 便捷：用固定 HMAC 键消费一次。 */
function consume(db: D1Database | undefined, over: Partial<Parameters<typeof consumeRateToken>[1]> = {}) {
  return consumeRateToken(db, {
    scope: "search",
    hmacKey: "test-hmac-key",
    ip: IP_A,
    tier: "overseas",
    windowSec: 60,
    limit: 5,
    nowMs: NOW,
    ...over,
  })
}

describe("窗口工具", () => {
  it("windowIndex / windowStart 按窗口切片；非法 windowSec → -1 / nowMs", () => {
    expect(windowIndex(NOW, 60)).toBe(Math.floor(NOW / 60_000))
    expect(windowStart(NOW, 60)).toBe(Math.floor(NOW / 60_000) * 60_000)
    expect(windowIndex(NOW, 0)).toBe(-1)
    expect(windowStart(NOW, 0)).toBe(NOW)
    expect(windowIndex(Number.NaN, 60)).toBe(-1)
  })

  it("retryAfterSecFor：按窗口剩余时间向上取整，最小 1s", () => {
    expect(retryAfterSecFor(NOW, 60)).toBe(60)
    expect(retryAfterSecFor(NOW + 59_500, 60)).toBe(1)
    expect(retryAfterSecFor(NOW + 30_000, 60)).toBe(30)
    expect(retryAfterSecFor(NOW, 0)).toBe(1)
  })
})

describe("bucket_key：HMAC 隐私（plan §5 验收项）", () => {
  it("是 64 位 hex（HMAC-SHA256）", async () => {
    const key = await bucketKeyFor({ scope: "search", hmacKey: "k", ip: IP_A, tier: "overseas", nowMs: NOW, windowSec: 60 })
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it("**不含 IP 明文**（也含 IPv6 形态），且不是裸 sha256(ip)", async () => {
    for (const ip of [IP_A, IP_B, "2a06:98c0:3600::103", "1.2.3.4"]) {
      const key = await bucketKeyFor({ scope: "search", hmacKey: "k", ip, tier: "overseas", nowMs: NOW, windowSec: 60 })
      expect(key).not.toContain(ip)
      expect(key).not.toContain(ip.replace(/[.:]/g, ""))
      // 裸 sha256(ip) 可被彩虹表穷举（IPv4 空间只有 2^32）→ 必须**不等**于它
      expect(key).not.toBe(await sha256Hex(ip))
      expect(key).not.toBe(await sha256Hex(`search|overseas|${ip}|${windowIndex(NOW, 60)}`))
    }
  })

  it("确定性：同 scope/tier/ip/窗口 → 同一个桶；换任一维度 → 不同桶", async () => {
    const base = { scope: "search", hmacKey: "k", ip: IP_A, tier: "overseas", nowMs: NOW, windowSec: 60 } as const
    expect(await bucketKeyFor(base)).toBe(await bucketKeyFor(base))
    expect(await bucketKeyFor({ ...base, ip: IP_B })).not.toBe(await bucketKeyFor(base))
    expect(await bucketKeyFor({ ...base, scope: "llm" })).not.toBe(await bucketKeyFor(base))
    expect(await bucketKeyFor({ ...base, tier: "cn_idc" })).not.toBe(await bucketKeyFor(base))
    expect(await bucketKeyFor({ ...base, nowMs: NOW + 60_000 })).not.toBe(await bucketKeyFor(base))
    expect(await bucketKeyFor({ ...base, hmacKey: "k2" })).not.toBe(await bucketKeyFor(base))
  })

  it("global 桶与 IP 无关（全局匿名熔断是**一个**桶）；block 桶跨窗口稳定", async () => {
    const g1 = await bucketKeyFor({ scope: "global", hmacKey: "k", ip: IP_A, nowMs: NOW, windowSec: 60 })
    const g2 = await bucketKeyFor({ scope: "global", hmacKey: "k", ip: IP_B, nowMs: NOW, windowSec: 60 })
    const g3 = await bucketKeyFor({ scope: "global", hmacKey: "k", nowMs: NOW, windowSec: 60 })
    expect(g1).toBe(g2)
    expect(g1).toBe(g3)
    const b1 = await bucketKeyFor({ scope: "block", hmacKey: "k", ip: IP_A, tier: "overseas", nowMs: 0, windowSec: 60 })
    const b2 = await bucketKeyFor({ scope: "block", hmacKey: "k", ip: IP_A, tier: "overseas", nowMs: 0, windowSec: 60 })
    expect(b1).toBe(b2)
  })

  it("hmacSha256Hex 是标准 HMAC-SHA256（与 RFC 4231 test case 2 对齐）", async () => {
    // key = "Jefe", data = "what do ya want for nothing?" → 已知向量
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    )
  })
})

describe("HMAC 键来源（不新增 secret，plan §5）", () => {
  it("从 PROXY_SHARED_SECRET 派生：确定性、64 hex、不同 secret 不同键", async () => {
    const a = await deriveRateLimitHmacKey({ PROXY_SHARED_SECRET: "s3cr3t" })
    const b = await deriveRateLimitHmacKey({ PROXY_SHARED_SECRET: "s3cr3t" })
    const c = await deriveRateLimitHmacKey({ PROXY_SHARED_SECRET: "other" })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(c)
    // 派生键 ≠ secret 本身（绝不把 secret 当键直接用）
    expect(a).not.toContain("s3cr3t")
    expect(a).toBe(await sha256Hex("prism-ratelimit-v1|s3cr3t"))
  })

  it("未配置 / 非法 → 退化常量 + 可被识别（隐私强度下降，生产必须配置）", async () => {
    for (const env of [{}, undefined, null, { PROXY_SHARED_SECRET: "" }, { PROXY_SHARED_SECRET: "   " }, { PROXY_SHARED_SECRET: 123 }]) {
      const key = await deriveRateLimitHmacKey(env)
      expect(key).toBe(RATE_LIMIT_HMAC_KEY_FALLBACK)
      expect(isDegradedHmacKey(key)).toBe(true)
    }
    expect(isDegradedHmacKey(await deriveRateLimitHmacKey({ PROXY_SHARED_SECRET: "x" }))).toBe(false)
  })
})

describe("consumeRateToken：固定窗口原子计数", () => {
  it("窗口内累加：limit=5 → 前 5 次放行，第 6 次拒绝并给 retryAfter", async () => {
    const { db } = makeDb()
    for (let i = 1; i <= 5; i++) {
      const r = await consume(db)
      expect(r.ok).toBe(true)
      expect(r.count).toBe(i)
      expect(r.degraded).toBe(false)
      expect(r.retryAfterSec).toBe(0)
    }
    const denied = await consume(db)
    expect(denied.ok).toBe(false)
    expect(denied.count).toBe(5)
    expect(denied.limit).toBe(5)
    expect(denied.retryAfterSec).toBeGreaterThan(0)
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60)
  })

  it("跨窗口重置：下一个 60s 窗口重新放行，且是新的一行", async () => {
    const { db, rows } = makeDb()
    for (let i = 0; i < 5; i++) await consume(db)
    expect((await consume(db)).ok).toBe(false)
    expect(rows.size).toBe(1)

    const next = await consume(db, { nowMs: NOW + 60_000 })
    expect(next.ok).toBe(true)
    expect(next.count).toBe(1)
    expect(rows.size).toBe(2) // 新窗口 = 新桶（旧行等清理）
  })

  it("不同 IP / 不同 scope / 不同档位互不占用额度", async () => {
    const { db } = makeDb()
    for (let i = 0; i < 5; i++) await consume(db)
    expect((await consume(db)).ok).toBe(false)
    expect((await consume(db, { ip: IP_B })).ok).toBe(true) // 另一个 IP
    expect((await consume(db, { scope: "llm" })).ok).toBe(true) // 另一个 scope
    expect((await consume(db, { tier: "cn_idc" })).ok).toBe(true) // 另一个档位
  })

  it("limit<=0 → 一律拒绝（熔断兜底），不算 degraded", async () => {
    const { db } = makeDb()
    const r = await consume(db, { limit: 0 })
    expect(r.ok).toBe(false)
    expect(r.limit).toBe(0)
    expect(r.degraded).toBe(false)
    expect(r.retryAfterSec).toBeGreaterThan(0)
  })

  it("参数非法（windowSec<=0 / nowMs 非有限）→ fail-open + degraded", async () => {
    const { db } = makeDb()
    for (const bad of [
      { windowSec: 0 },
      { windowSec: -1 },
      { windowSec: Number.NaN },
      { nowMs: Number.NaN },
    ]) {
      const r = await consume(db, bad)
      expect(r.ok).toBe(true)
      expect(r.degraded).toBe(true)
      expect(r.bucketKey).toBe("")
    }
  })
})

describe("consumeRateToken：并发不超卖（plan §5 核心保证）", () => {
  it("limit=5，并发 20 次 → **恰好 5 次成功**，行计数恒为 5", async () => {
    const { db, rows } = makeDb()
    const results = await Promise.all(Array.from({ length: 20 }, () => consume(db)))
    const ok = results.filter((r) => r.ok)
    expect(ok).toHaveLength(5)
    expect(results.filter((r) => !r.ok)).toHaveLength(15)
    expect([...rows.values()][0].count).toBe(5)
    // 成功者拿到的计数互不相同（1..5），说明没有重复占位
    expect(ok.map((r) => r.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it("limit=1，并发 10 次 → 恰好 1 次成功", async () => {
    const { db, rows } = makeDb()
    const results = await Promise.all(Array.from({ length: 10 }, () => consume(db, { limit: 1 })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect([...rows.values()][0].count).toBe(1)
  })

  it("并发跨两个窗口：各自独立计数（互不干扰）", async () => {
    const { db, rows } = makeDb()
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => consume(db, { limit: 3 })),
      ...Array.from({ length: 6 }, () => consume(db, { limit: 3, nowMs: NOW + 60_000 })),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(6) // 每个窗口各 3
    expect(rows.size).toBe(2)
    for (const row of rows.values()) expect(row.count).toBe(3)
  })
})

describe("consumeRateToken：降级（可用性优先，与 quota.ts 一致）", () => {
  it("D1 缺失 → fail-open + degraded", async () => {
    for (const missing of [undefined, null]) {
      const r = await consume(missing as undefined)
      expect(r.ok).toBe(true)
      expect(r.degraded).toBe(true)
      expect(r.count).toBe(0)
      expect(r.limit).toBe(5)
    }
  })

  it("INSERT / UPDATE / SELECT 任一异常 → fail-open + degraded（绝不抛错）", async () => {
    for (const failOn of ["INSERT OR IGNORE", "count = count + 1", "SELECT count FROM rate_counters"]) {
      const { db } = makeDb({ failOn })
      const r = await consume(db)
      expect(r.ok).toBe(true)
      expect(r.degraded).toBe(true)
    }
  })

  it("计数行读不到（被清理）→ 视为 0，仍能放行", async () => {
    const { db, rows } = makeDb()
    await consume(db)
    rows.clear()
    const r = await consume(db)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(1)
  })
})

describe("peekRateCount：只读诊断（不占名额）", () => {
  it("不改变计数（连读 3 次仍是同一个值）", async () => {
    const { db, rows } = makeDb()
    await consume(db)
    await consume(db)
    const p1 = await peekRateCount(db, { scope: "search", hmacKey: "test-hmac-key", ip: IP_A, tier: "overseas", windowSec: 60, nowMs: NOW })
    const p2 = await peekRateCount(db, { scope: "search", hmacKey: "test-hmac-key", ip: IP_A, tier: "overseas", windowSec: 60, nowMs: NOW })
    expect(p1.count).toBe(2)
    expect(p2.count).toBe(2)
    expect([...rows.values()][0].count).toBe(2)
    expect(p1.degraded).toBe(false)
    expect(p1.bucketKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it("空桶 → 0；D1 缺失 → 0 + degraded", async () => {
    const { db } = makeDb()
    expect((await peekRateCount(db, { scope: "search", hmacKey: "k", ip: IP_A, tier: "overseas", windowSec: 60, nowMs: NOW })).count).toBe(0)
    const missing = await peekRateCount(undefined, { scope: "search", hmacKey: "k", ip: IP_A, windowSec: 60, nowMs: NOW })
    expect(missing.count).toBe(0)
    expect(missing.degraded).toBe(true)
  })
})

describe("突发封禁（plan §6：block_until，复用同一张表 scope=block）", () => {
  it("写入后读到 block_until；过期后读到 0", async () => {
    const { db, rows } = makeDb()
    await writeBlockUntil(db, {
      hmacKey: "test-hmac-key",
      ip: IP_A,
      tier: "overseas",
      blockUntilMs: NOW + 60_000,
      nowMs: NOW,
      blockSec: 60,
    })
    expect(rows.size).toBe(1)
    expect(await readBlockUntil(db, { hmacKey: "test-hmac-key", ip: IP_A, tier: "overseas", nowMs: NOW })).toBe(NOW + 60_000)
    expect(await readBlockUntil(db, { hmacKey: "test-hmac-key", ip: IP_A, tier: "overseas", nowMs: NOW + 60_001 })).toBe(0)
  })

  it("封禁按 IP 生效：别的 IP 不受影响；未封禁 → 0；D1 缺失 → 0（fail-open）", async () => {
    const { db } = makeDb()
    await writeBlockUntil(db, {
      hmacKey: "test-hmac-key",
      ip: IP_A,
      tier: "overseas",
      blockUntilMs: NOW + 60_000,
      nowMs: NOW,
      blockSec: 60,
    })
    expect(await readBlockUntil(db, { hmacKey: "test-hmac-key", ip: IP_B, tier: "overseas", nowMs: NOW })).toBe(0)
    expect(await readBlockUntil(db, { hmacKey: "test-hmac-key", nowMs: NOW })).toBe(0)
    expect(await readBlockUntil(undefined, { hmacKey: "k", ip: IP_A, nowMs: NOW })).toBe(0)
  })

  it("重复封禁幂等（不会插出第二行）", async () => {
    const { db, rows } = makeDb()
    for (const delta of [60_000, 90_000]) {
      await writeBlockUntil(db, {
        hmacKey: "test-hmac-key",
        ip: IP_A,
        tier: "overseas",
        blockUntilMs: NOW + delta,
        nowMs: NOW,
        blockSec: Math.floor(delta / 1000),
      })
    }
    expect(rows.size).toBe(1)
    expect(await readBlockUntil(db, { hmacKey: "test-hmac-key", ip: IP_A, tier: "overseas", nowMs: NOW })).toBe(NOW + 90_000)
  })

  it("D1 异常 → 写入静默失败（null）、读取不封禁（fail-open）", async () => {
    const { db } = makeDb({ failOn: "INSERT OR IGNORE" })
    expect(
      await writeBlockUntil(db, { hmacKey: "k", ip: IP_A, blockUntilMs: NOW + 60_000, nowMs: NOW, blockSec: 60 }),
    ).toBeNull()
    const { db: db2 } = makeDb({ failOn: "SELECT count FROM rate_counters" })
    expect(await readBlockUntil(db2, { hmacKey: "k", ip: IP_A, nowMs: NOW })).toBe(0)
  })
})

describe("purgeExpiredCounters：过期行清理（不引入定时任务）", () => {
  it("只删 window_start 早于阈值的行，返回删除行数", async () => {
    const { db, rows } = makeDb()
    await consume(db, { nowMs: NOW }) // 现在
    await consume(db, { nowMs: NOW - 2 * 3_600_000 }) // 2 小时前
    await consume(db, { nowMs: NOW - 3 * 3_600_000 }) // 3 小时前
    expect(rows.size).toBe(3)
    const deleted = await purgeExpiredCounters(db, NOW) // 默认 1h 前的都算过期
    expect(deleted).toBe(2)
    expect(rows.size).toBe(1)
  })

  it("batch 限制单次删除量；无过期行 → 0；D1 缺失/异常 → 0（绝不抛错）", async () => {
    const { db, rows } = makeDb()
    for (let i = 1; i <= 5; i++) await consume(db, { nowMs: NOW - i * 7_200_000 })
    expect(await purgeExpiredCounters(db, NOW, { batch: 2 })).toBe(2)
    expect(rows.size).toBe(3)
    expect(await purgeExpiredCounters(db, NOW - 10 * 7_200_000)).toBe(0)
    expect(await purgeExpiredCounters(undefined, NOW)).toBe(0)
    const { db: bad } = makeDb({ failOn: "DELETE FROM rate_counters" })
    expect(await purgeExpiredCounters(bad, NOW)).toBe(0)
  })

  it("minAgeMs 可调：更严格的阈值会留下更多行", async () => {
    const { db, rows } = makeDb()
    await consume(db, { nowMs: NOW - 120_000 }) // 2 分钟前
    expect(await purgeExpiredCounters(db, NOW, { minAgeMs: 60_000 })).toBe(1)
    await consume(db, { nowMs: NOW - 120_000 })
    expect(await purgeExpiredCounters(db, NOW, { minAgeMs: 300_000 })).toBe(0)
    expect(rows.size).toBe(1)
  })
})
