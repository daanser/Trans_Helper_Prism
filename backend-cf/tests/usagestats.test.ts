// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 用量汇总单测（M4-W3 月账原料）
// 全 mock：D1（按 SQL 形状返回罐装行 + 记录是否发生写入）、JWT/admin key 走真实签发（零网络）。
// 覆盖：天数解析与夹取 / 整形纯函数 / 路由 401·503·200 / **绝不写库** / 响应不含密钥或 IP。
import { describe, it, expect } from "vitest"
import { app } from "../src/index"
import { fetchUsageSummary, parseUsageDays, shapeUsageSummary, USAGE_MAX_DAYS } from "../src/usagestats"
import type { Env } from "../src/types"

const ADMIN = "admin-secret"
const NOW = 1_789_000_000_000

interface Canned {
  endpoints?: unknown[]
  days?: unknown[]
  quota?: unknown
  ingest?: unknown
}

/** 按 SQL 形状返回罐装行的 D1 mock；`writes` 记录任何 run()（用于"只读"断言）。 */
function makeDb(canned: Canned) {
  const writes: string[] = []
  const seen: string[] = []
  const db = {
    prepare(sql: string) {
      seen.push(sql)
      const stmt = {
        bind: () => stmt,
        async all() {
          if (/GROUP BY endpoint/i.test(sql)) return { results: canned.endpoints ?? [] }
          if (/date\(created_at/i.test(sql)) return { results: canned.days ?? [] }
          return { results: [] }
        },
        async first() {
          if (/FROM quotas/i.test(sql)) return canned.quota ?? null
          if (/FROM ingest_runs/i.test(sql)) return canned.ingest ?? null
          return null
        },
        async run() {
          writes.push(sql)
          return { success: true }
        },
      }
      return stmt
    },
  }
  return { db: db as unknown as D1Database, writes, seen }
}

function makeEnv(db?: D1Database): Env {
  return { ADMIN_API_KEY: ADMIN, DB: db } as unknown as Env
}

describe("parseUsageDays", () => {
  it("缺省/非法回默认，超上限夹取", () => {
    expect(parseUsageDays(undefined)).toBe(30)
    expect(parseUsageDays("")).toBe(30)
    expect(parseUsageDays("abc")).toBe(30)
    expect(parseUsageDays("0")).toBe(30)
    expect(parseUsageDays("-5")).toBe(30)
    expect(parseUsageDays("7")).toBe(7)
    expect(parseUsageDays("365")).toBe(365)
    expect(parseUsageDays("99999")).toBe(USAGE_MAX_DAYS)
    expect(parseUsageDays("12", 99)).toBe(12)
  })
})

describe("shapeUsageSummary", () => {
  it("汇总各 endpoint 的调用与 token，并对延迟取整", () => {
    const out = shapeUsageSummary({
      days: 30,
      since: NOW - 1000,
      until: NOW,
      endpoints: [
        { endpoint: "embeddings", calls: 10, ok: 9, failed: 1, tokens_in: 100, tokens_out: 0, avg_latency_ms: 240.6 },
        { endpoint: "rerank", calls: 4, ok: 4, failed: 0, tokens_in: 0, tokens_out: 0, avg_latency_ms: null },
      ],
      days_rows: [{ day: "2026-09-11", calls: 14, tokens_in: 100, tokens_out: 0 }],
      quota: { accounts: 2, used_tokens: 1234 },
      ingest: { runs: 8, failed: 1, points_upserted: 42, last_success_at: NOW - 500 },
      limitTokens: 300000,
    })
    expect(out.totals).toEqual({ calls: 14, tokens_in: 100, tokens_out: 0, failed: 1 })
    expect(out.by_endpoint[0].avg_latency_ms).toBe(241)
    expect(out.by_endpoint[1].avg_latency_ms).toBeNull()
    expect(out.quota_window).toEqual({ accounts: 2, used_tokens: 1234, limit_tokens: 300000 })
    expect(out.ingest.last_success_at).toBe(NOW - 500)
    expect(out.by_day).toHaveLength(1)
  })

  it("空数据不抛错：全零 + null 时间", () => {
    const out = shapeUsageSummary({
      days: 30,
      since: 0,
      until: NOW,
      endpoints: [],
      days_rows: [],
      quota: null,
      ingest: null,
      limitTokens: 300000,
    })
    expect(out.totals).toEqual({ calls: 0, tokens_in: 0, tokens_out: 0, failed: 0 })
    expect(out.by_endpoint).toEqual([])
    expect(out.ingest).toEqual({ runs: 0, failed: 0, points_upserted: 0, last_success_at: null })
  })
})

describe("fetchUsageSummary", () => {
  it("缺 D1 抛错（由路由映射 503，不假装成功）", async () => {
    await expect(fetchUsageSummary(null, { days: 30, nowMs: NOW, limitTokens: 300000 })).rejects.toThrow()
  })

  it("**只读**：四条聚合查询全是 SELECT，绝不写库", async () => {
    const { db, writes, seen } = makeDb({ endpoints: [], days: [], quota: null, ingest: null })
    await fetchUsageSummary(db, { days: 30, nowMs: NOW, limitTokens: 300000 })
    expect(writes).toEqual([])
    expect(seen.every((s) => /^\s*SELECT/i.test(s))).toBe(true)
  })
})

describe("GET /api/v1/admin/usage/summary", () => {
  it("无凭据 → 401", async () => {
    const resp = await app.request("/api/v1/admin/usage/summary", {}, makeEnv())
    expect(resp.status).toBe(401)
  })

  it("缺 D1 → 503 db-unconfigured", async () => {
    const resp = await app.request(
      "/api/v1/admin/usage/summary",
      { headers: { Authorization: `Bearer ${ADMIN}` } },
      makeEnv(undefined),
    )
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: "db-unconfigured" })
  })

  it("200：形状正确、只读、响应不含密钥", async () => {
    const { db, writes } = makeDb({
      endpoints: [
        { endpoint: "chat", calls: 3, ok: 3, failed: 0, tokens_in: 900, tokens_out: 200, avg_latency_ms: 1200 },
      ],
      days: [{ day: "2026-09-11", calls: 3, tokens_in: 900, tokens_out: 200 }],
      quota: { accounts: 1, used_tokens: 400 },
      ingest: { runs: 2, failed: 0, points_upserted: 5, last_success_at: NOW - 100 },
    })
    const resp = await app.request(
      "/api/v1/admin/usage/summary?days=7",
      { headers: { Authorization: `Bearer ${ADMIN}` } },
      makeEnv(db),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.days).toBe(7)
    expect((body.totals as { calls: number }).calls).toBe(3)
    expect((body.totals as { tokens_in: number }).tokens_in).toBe(900)
    expect(writes).toEqual([])
    expect(JSON.stringify(body)).not.toContain(ADMIN)
    expect(JSON.stringify(body)).not.toMatch(/sk-/)
  })

  it("?days 超上限被夹到 365", async () => {
    const { db } = makeDb({ endpoints: [], days: [], quota: null, ingest: null })
    const resp = await app.request(
      "/api/v1/admin/usage/summary?days=99999",
      { headers: { Authorization: `Bearer ${ADMIN}` } },
      makeEnv(db),
    )
    expect(((await resp.json()) as { days: number }).days).toBe(365)
  })
})
