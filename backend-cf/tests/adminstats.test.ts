// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — admin 用量/Key 池接口单测（tasks.md T3.3 / T3.6）
// 全 mock：D1（记录 SQL+bind）、KV（内存，可注入失败）、JWT（真实签发，无网络）。零网络。
// 覆盖：
//   ① /admin/usage 聚合与 limitTokens(env) 一致、封禁状态、窗口过期、缺 D1 → 503；
//   ② /admin/keys 只出 ref（**响应 JSON 里不得出现 sk- 形状**）、pools 与 env 一致、DB 空 → 空数组；
//   ③ POST /admin/keys 的 upsert + 审计（key_enable/key_disable、target=key_ref）+ KV 运行时效；
//   ④ admin 鉴权二选一：ADMIN_API_KEY 或 JWT role=admin（含「未配 key + JWT admin → 放行」）。
import { describe, it, expect, vi, afterEach } from "vitest"
import { app } from "../src/index"
import { issueSession } from "../src/auth"
import { KEY_DENY_PREFIX } from "../src/keyadmin"
import type { Env } from "../src/types"

afterEach(() => {
  vi.restoreAllMocks()
})

/** 明显假的占位 secret（绝不是真 key）：只用于「不得出现在响应里」的断言。 */
const EMBED_SECRETS = ["sk-fake-embed-0001", "sk-fake-embed-0002"]
const LLM_SECRETS = ["sk-fake-llm-0001"]

const NOW = Date.now()

/** D1 mock：按 SQL 形状返回预置行，并记录每次 bind 的 sql+args。 */
function makeDb(
  opts: {
    usageRows?: unknown[]
    keyRows?: unknown[]
    auditRows?: unknown[]
    fail?: "usage" | "keys" | "all"
  } = {},
) {
  const calls: Array<{ sql: string; args: unknown[]; op: "run" | "all" | "first" }> = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.args = args
          return stmt
        },
        async run() {
          calls.push({ sql, args: stmt.args, op: "run" })
          if (opts.fail === "all") throw new Error("d1-failed")
          return { success: true, results: [], meta: { changes: 1 } }
        },
        async all() {
          calls.push({ sql, args: stmt.args, op: "all" })
          if (/FROM accounts/i.test(sql)) {
            if (opts.fail === "usage" || opts.fail === "all") throw new Error("d1-failed")
            return { success: true, results: opts.usageRows ?? [], meta: { changes: 0 } }
          }
          if (/FROM provider_keys/i.test(sql)) {
            if (opts.fail === "keys" || opts.fail === "all") throw new Error("d1-failed")
            return { success: true, results: opts.keyRows ?? [], meta: { changes: 0 } }
          }
          if (/FROM audit_log/i.test(sql)) {
            return { success: true, results: opts.auditRows ?? [], meta: { changes: 0 } }
          }
          return { success: true, results: [], meta: { changes: 0 } }
        },
        async first() {
          calls.push({ sql, args: stmt.args, op: "first" })
          return null
        },
      }
      return stmt
    },
    async batch(stmts: unknown[]) {
      return stmts
    },
  } as unknown as D1Database
  return { db, calls }
}

/** 内存 KV mock（可注入读/写失败）。 */
function makeKv(opts: { failGet?: boolean; failPut?: boolean; seed?: Record<string, string> } = {}) {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}))
  const kv = {
    get: async (k: string) => {
      if (opts.failGet) throw new Error("kv-get-failed")
      return store.get(k) ?? null
    },
    put: async (k: string, v: string) => {
      if (opts.failPut) throw new Error("kv-put-failed")
      store.set(k, v)
    },
  } as unknown as KVNamespace
  return { kv, store }
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: undefined as never,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    ADMIN_API_KEY: "admin-secret",
    JWT_SECRET: "j".repeat(64),
    EMBED_POOL_KEYS: EMBED_SECRETS.join(","),
    LLM_POOL_KEYS: LLM_SECRETS.join(","),
    QUOTA_WINDOW_TOKENS: "1000",
    QUOTA_WINDOW_HOURS: "5",
    ...over,
  } as unknown as Env
}

/** 签一个真 JWT（不触网络）。 */
async function jwt(env: Env, role: "user" | "admin", sub = "acc-admin-1"): Promise<string> {
  return await issueSession(env, { sub, handle: role, role })
}

/** 审计断言辅助：从记录里取 audit_log 的插入语句。 */
function auditInserts(calls: Array<{ sql: string; args: unknown[] }>) {
  return calls.filter((c) => /INSERT INTO audit_log/i.test(c.sql))
}

/** 默认 usage 行（acc-1 正常 / acc-2 超额 / acc-3 封禁且无 quotas 行）。 */
function usageRows() {
  return [
    {
      account_id: "acc-1",
      status: "active",
      created_at: NOW - 60_000,
      period_start: NOW - 3_600_000,
      used_cost: 250,
    },
    {
      account_id: "acc-2",
      status: "active",
      created_at: NOW - 50_000,
      period_start: NOW - 3_600_000,
      used_cost: 1500, // 超限 → used_pct 夹到 100
    },
    {
      account_id: "acc-3",
      status: "banned",
      created_at: NOW - 40_000,
      period_start: null, // 无 quotas 行（LEFT JOIN → NULL）
      used_cost: null,
    },
  ]
}

function keyRows() {
  // 顺序与 SQL 的 `ORDER BY pool ASC, key_ref ASC` 一致（mock 不做排序，故 fixture 按序给）
  return [
    {
      key_ref: "embed-key-1",
      pool: "embed",
      status: "evicted",
      success_count: 3,
      failure_count: 5,
      total_cost: 1.5,
      enabled: 0,
      updated_at: NOW - 2000,
    },
    {
      key_ref: "llm-key-0",
      pool: "llm",
      status: "active",
      success_count: 7,
      failure_count: 1,
      total_cost: 0.25,
      enabled: 1,
      updated_at: NOW - 1000,
    },
  ]
}

// ─────────────────────────── GET /admin/usage ───────────────────────────

describe("GET /api/v1/admin/usage", () => {
  it("聚合正确：used_pct 与 limitTokens(env) 一致、封禁状态透出、total 汇总", async () => {
    const { db } = makeDb({ usageRows: usageRows(), keyRows: keyRows() })
    const resp = await app.request(
      "/api/v1/admin/usage",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      total: Record<string, number>
      items: Array<Record<string, unknown>>
      keys: Array<Record<string, unknown>>
      window: Record<string, number>
    }

    // limitTokens(env) = QUOTA_WINDOW_TOKENS = 1000；window_hours = 5
    expect(body.window).toEqual({ window_hours: 5, limit_tokens: 1000 })
    expect(body.total).toEqual({ accounts: 3, used_tokens: 1750, limit_tokens: 1000, window_hours: 5 })

    const acc1 = body.items.find((i) => i.account_id === "acc-1")!
    expect(acc1.used_tokens).toBe(250)
    expect(acc1.limit_tokens).toBe(1000)
    expect(acc1.used_pct).toBe(25) // 250 / 1000
    expect(acc1.remaining_pct).toBe(75)
    expect(acc1.exceeded).toBe(false)
    expect(acc1.status).toBe("active")
    expect(acc1.window_start).toBe(NOW - 3_600_000)

    const acc2 = body.items.find((i) => i.account_id === "acc-2")!
    expect(acc2.used_pct).toBe(100) // 150% 夹到 100
    expect(acc2.remaining_pct).toBe(0)
    expect(acc2.exceeded).toBe(true)

    // 封禁账号：状态原样透出，且没有 quotas 行 → used 0
    const acc3 = body.items.find((i) => i.account_id === "acc-3")!
    expect(acc3.status).toBe("banned")
    expect(acc3.used_tokens).toBe(0)
    expect(acc3.used_pct).toBe(0)
    expect(acc3.exceeded).toBe(false)

    // requests / llm_tokens_* 无法从 key_usage 归属到账号 → 如实 null（不编造）
    expect(body.items.every((i) => i.requests === null)).toBe(true)
    expect(body.items.every((i) => i.llm_tokens_in === null && i.llm_tokens_out === null)).toBe(true)

    // keys[] 是 provider_keys 的脱敏投影
    expect(body.keys).toHaveLength(2)
    const k = body.keys.find((r) => r.key_ref === "llm-key-0")!
    expect(k.pool).toBe("llm")
    expect(k.success_count).toBe(7)
    expect(k.failure_count).toBe(1)
    expect(k.total_cost).toBe(0.25)
    expect(k.enabled).toBe(true) // INTEGER 1 → 布尔

    // ── 绝不泄漏 secret：响应 JSON 里不得有 sk- 形状或 env 里的真值 ──
    const json = JSON.stringify(body)
    expect(json).not.toMatch(/sk-/)
    for (const s of [...EMBED_SECRETS, ...LLM_SECRETS]) expect(json).not.toContain(s)
  })

  it("窗口过期 → 按新窗口返回（used 归零、window_start 前移），不写库", async () => {
    const { db, calls } = makeDb({
      usageRows: [
        { account_id: "acc-old", status: "active", created_at: 1, period_start: NOW - 6 * 3_600_000, used_cost: 900 },
      ],
    })
    const resp = await app.request(
      "/api/v1/admin/usage",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    const body = (await resp.json()) as { items: Array<Record<string, number>>; total: Record<string, number> }
    expect(body.items[0].used_tokens).toBe(0)
    expect(body.items[0].used_pct).toBe(0)
    expect(body.items[0].window_start).toBeGreaterThan(NOW - 1000)
    expect(body.total.used_tokens).toBe(0)
    // 只读接口：不产生任何写语句
    expect(calls.every((c) => c.op === "all")).toBe(true)
  })

  it("QUOTA_WINDOW_HOURS/TOKENS 覆盖生效（window_hours=2、limit=5000）", async () => {
    const { db } = makeDb({ usageRows: usageRows() })
    const resp = await app.request(
      "/api/v1/admin/usage",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db, QUOTA_WINDOW_HOURS: "2", QUOTA_WINDOW_TOKENS: "5000" }),
    )
    const body = (await resp.json()) as {
      window: Record<string, number>
      items: Array<{ account_id: string; used_pct: number }>
    }
    expect(body.window).toEqual({ window_hours: 2, limit_tokens: 5000 })
    expect(body.items.find((i) => i.account_id === "acc-1")!.used_pct).toBe(5) // 250 / 5000
  })

  it("key 表读失败 → keys[] 降级为空数组，用量总览仍 200", async () => {
    const { db } = makeDb({ usageRows: usageRows(), fail: "keys" })
    const resp = await app.request(
      "/api/v1/admin/usage",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { keys: unknown[]; items: unknown[] }
    expect(body.keys).toEqual([])
    expect(body.items).toHaveLength(3)
  })

  it("缺 D1 → 503 db-unconfigured；SQL 异常 → 503 db-unavailable", async () => {
    let resp = await app.request("/api/v1/admin/usage", { headers: { Authorization: "Bearer admin-secret" } }, makeEnv())
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: "db-unconfigured" })

    const { db } = makeDb({ fail: "usage" })
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    resp = await app.request(
      "/api/v1/admin/usage",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: "db-unavailable" })
  })
})

// ─────────────────────────── GET /admin/keys ───────────────────────────

describe("GET /api/v1/admin/keys", () => {
  it("pools 与 env 一致，keys[] 只有 ref / 计数 / 成本，响应里没有 sk-", async () => {
    const { db } = makeDb({ keyRows: keyRows() })
    const resp = await app.request(
      "/api/v1/admin/keys",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      keys: Array<Record<string, unknown>>
      pools: Array<{ pool: string; configured: number; refs: string[] }>
      db_rows: number
    }

    expect(body.pools).toEqual([
      { pool: "embed", configured: 2, refs: ["embed-key-0", "embed-key-1"] },
      // rerank 未单独配置 → 并入 llm_pool（plan §2），ref 前缀改写为 rerank-key-N
      { pool: "llm", configured: 1, refs: ["llm-key-0"] },
      { pool: "rerank", configured: 1, refs: ["rerank-key-0"] },
    ])
    expect(body.db_rows).toBe(2)
    expect(body.keys.map((k) => k.key_ref)).toEqual(["embed-key-1", "llm-key-0"]) // ORDER BY pool, key_ref

    const json = JSON.stringify(body)
    expect(json).not.toMatch(/sk-/)
    for (const s of [...EMBED_SECRETS, ...LLM_SECRETS]) expect(json).not.toContain(s)
  })

  it("DB 空 → keys: []、db_rows: 0（200，不是 503）", async () => {
    const { db } = makeDb({ keyRows: [] })
    const resp = await app.request(
      "/api/v1/admin/keys",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { keys: unknown[]; db_rows: number; pools: unknown[] }
    expect(body.keys).toEqual([])
    expect(body.db_rows).toBe(0)
    expect(body.pools).toHaveLength(3)
  })

  it("缺 D1 → 仍 200（pools 来自 env，不依赖 D1）", async () => {
    const resp = await app.request(
      "/api/v1/admin/keys",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv(),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { keys: unknown[]; db_rows: number; pools: Array<{ refs: string[] }> }
    expect(body.keys).toEqual([])
    expect(body.db_rows).toBe(0)
    expect(body.pools[0].refs).toEqual(["embed-key-0", "embed-key-1"])
  })

  it("RERANK_POOL_KEYS 单独配置时 rerank 用自己的 ref", async () => {
    const { db } = makeDb({ keyRows: [] })
    const env = makeEnv({ DB: db, RERANK_POOL_KEYS: "sk-fake-rerank-0,sk-fake-rerank-1" })
    const resp = await app.request("/api/v1/admin/keys", { headers: { Authorization: "Bearer admin-secret" } }, env)
    const body = (await resp.json()) as { pools: Array<{ pool: string; refs: string[] }> }
    expect(body.pools.find((p) => p.pool === "rerank")!.refs).toEqual(["rerank-key-0", "rerank-key-1"])
    expect(JSON.stringify(body)).not.toMatch(/sk-/)
  })
})

// ─────────────────────────── POST /admin/keys ───────────────────────────

describe("POST /api/v1/admin/keys", () => {
  it("禁用：upsert（enabled=0）+ 审计 key_disable（target=key_ref）+ KV 记入 keydeny", async () => {
    const { db, calls } = makeDb({ keyRows: keyRows() })
    const { kv, store } = makeKv()
    const env = makeEnv({ DB: db, SEARCH_CACHE: kv })
    const token = await jwt(env, "admin", "acc-admin-9")

    const resp = await app.request(
      "/api/v1/admin/keys",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key_ref: "llm-key-0", pool: "llm", enabled: false }),
      },
      env,
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      key_ref: "llm-key-0",
      pool: "llm",
      enabled: false,
      configured: true,
      runtime_applied: true,
      audit_written: true,
      disabled_refs: ["llm-key-0"],
    })

    // ① upsert：单条 ON CONFLICT，bind 里只有 ref/pool（绝无 secret）
    const upsert = calls.find((c) => /INSERT INTO provider_keys/i.test(c.sql))!
    expect(upsert.sql).toContain("ON CONFLICT(pool, key_ref) DO UPDATE")
    expect(upsert.args).toContain("llm-key-0")
    expect(upsert.args).toContain("llm")
    expect(upsert.args).toContain(0) // enabled = 0
    expect(JSON.stringify(upsert.args)).not.toMatch(/sk-/)

    // ② 审计：action=key_disable、target=key_ref、detail=pool=…、actor=JWT 的 sub
    const audit = auditInserts(calls)
    expect(audit).toHaveLength(1)
    expect(audit[0].args[1]).toBe("acc-admin-9") // actor_id（JWT sub）
    expect(audit[0].args[2]).toBe("key_disable") // action
    expect(audit[0].args[3]).toBe("llm-key-0") // target = key_ref，不是真 key
    expect(audit[0].args[4]).toBe("pool=llm") // detail
    expect(JSON.stringify(audit[0].args)).not.toMatch(/sk-/)

    // ③ 运行时效：KV 记下禁用集合（只放 ref）
    expect(store.get(`${KEY_DENY_PREFIX}llm`)).toBe("llm-key-0")
    expect(JSON.stringify([...store.entries()])).not.toMatch(/sk-/)
  })

  it("上架：upsert（enabled=1）+ 审计 key_enable + 从 KV 禁用集移除", async () => {
    const { db, calls } = makeDb({ keyRows: keyRows() })
    const { kv, store } = makeKv({ seed: { [`${KEY_DENY_PREFIX}llm`]: "llm-key-0,llm-key-2" } })
    const env = makeEnv({ DB: db, SEARCH_CACHE: kv })

    const resp = await app.request(
      "/api/v1/admin/keys",
      {
        method: "POST",
        headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ key_ref: "llm-key-0", pool: "llm", enabled: true }),
      },
      env,
    )
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.enabled).toBe(true)
    expect(body.disabled_refs).toEqual(["llm-key-2"])
    expect(store.get(`${KEY_DENY_PREFIX}llm`)).toBe("llm-key-2")

    const upsert = calls.find((c) => /INSERT INTO provider_keys/i.test(c.sql))!
    expect(upsert.args).toContain(1) // enabled = 1
    expect(auditInserts(calls)[0].args[2]).toBe("key_enable")
    expect(auditInserts(calls)[0].args[1]).toBe("admin") // API key 通道的默认 actor
  })

  it("KV 写失败 → 请求仍 200（fail-open），runtime_applied=false，但 DB/审计照写", async () => {
    const { db, calls } = makeDb({ keyRows: [] })
    const { kv } = makeKv({ failPut: true })
    const env = makeEnv({ DB: db, SEARCH_CACHE: kv })

    const resp = await app.request(
      "/api/v1/admin/keys",
      {
        method: "POST",
        headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ key_ref: "embed-key-0", pool: "embed", enabled: false }),
      },
      env,
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.runtime_applied).toBe(false)
    expect(body.disabled_refs).toEqual([])
    expect(auditInserts(calls)).toHaveLength(1)
    expect(calls.some((c) => /INSERT INTO provider_keys/i.test(c.sql))).toBe(true)
  })

  it("非法 key_ref（真 key 形状）/ 非法 pool → 422，且不写库、不写审计", async () => {
    const { db, calls } = makeDb({ keyRows: [] })
    const env = makeEnv({ DB: db, SEARCH_CACHE: makeKv().kv })
    for (const payload of [
      { key_ref: "sk-fake-llm-0001", pool: "llm", enabled: false },
      { key_ref: "", pool: "llm" },
      { key_ref: "llm-key-0", pool: "not-a-pool" },
      { key_ref: "llm-key-0" }, // 缺 pool
    ]) {
      const resp = await app.request(
        "/api/v1/admin/keys",
        {
          method: "POST",
          headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        env,
      )
      expect(resp.status).toBe(422)
    }
    expect(calls).toHaveLength(0)
  })

  it("缺 D1 → 503 db-unconfigured", async () => {
    const resp = await app.request(
      "/api/v1/admin/keys",
      {
        method: "POST",
        headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ key_ref: "llm-key-0", pool: "llm", enabled: false }),
      },
      makeEnv(),
    )
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: "db-unconfigured" })
  })
})

// ─────────────────────────── admin 鉴权 ───────────────────────────

describe("admin 鉴权（二选一：ADMIN_API_KEY 或 JWT role=admin）", () => {
  const adminRoutes: Array<[string, RequestInit]> = [
    ["/api/v1/admin/usage", {}],
    ["/api/v1/admin/keys", {}],
    ["/api/v1/admin/audit", {}],
    ["/api/v1/admin/accounts/acc-1/ban", { method: "POST" }],
  ]

  it("无 Authorization / 错 key → 401 unauthorized", async () => {
    const { db } = makeDb({ auditRows: [] })
    const env = makeEnv({ DB: db })
    for (const [path, init] of adminRoutes) {
      let resp = await app.request(path, init, env)
      expect(resp.status).toBe(401)
      expect(await resp.json()).toEqual({ error: "unauthorized" })

      resp = await app.request(path, { ...init, headers: { Authorization: "Bearer wrong-key" } }, env)
      expect(resp.status).toBe(401)
    }
  })

  it("JWT role=admin → 放行（usage/keys/audit/ban 全部）", async () => {
    const { db, calls } = makeDb({ usageRows: [], keyRows: [], auditRows: [] })
    const env = makeEnv({ DB: db })
    const token = await jwt(env, "admin", "acc-admin-7")
    for (const [path, init] of adminRoutes) {
      const resp = await app.request(path, { ...init, headers: { Authorization: `Bearer ${token}` } }, env)
      expect(resp.status).toBe(200)
    }
    // ban 的审计 actor 是 JWT 的 sub（「谁封了谁」可查）
    const banAudit = auditInserts(calls).find((c) => c.args[2] === "ban")!
    expect(banAudit.args[1]).toBe("acc-admin-7")
  })

  it("JWT role=user → 401", async () => {
    const { db } = makeDb({ auditRows: [] })
    const env = makeEnv({ DB: db })
    const token = await jwt(env, "user", "acc-user-1")
    for (const [path, init] of adminRoutes) {
      const resp = await app.request(path, { ...init, headers: { Authorization: `Bearer ${token}` } }, env)
      expect(resp.status).toBe(401)
      expect(await resp.json()).toEqual({ error: "unauthorized" })
    }
  })

  it("ADMIN_API_KEY 未配置 + JWT admin → 放行（不是 503）", async () => {
    const { db } = makeDb({ usageRows: [], keyRows: [], auditRows: [] })
    const env = makeEnv({ DB: db, ADMIN_API_KEY: undefined })
    const token = await jwt(env, "admin", "acc-admin-8")
    for (const [path, init] of adminRoutes) {
      const resp = await app.request(path, { ...init, headers: { Authorization: `Bearer ${token}` } }, env)
      expect(resp.status).toBe(200)
    }
  })

  it("ADMIN_API_KEY 未配置 + 无/非 admin JWT → 401（不再 503）", async () => {
    const { db } = makeDb({ auditRows: [] })
    const env = makeEnv({ DB: db, ADMIN_API_KEY: undefined })
    let resp = await app.request("/api/v1/admin/keys", {}, env)
    expect(resp.status).toBe(401)
    const userToken = await jwt(env, "user")
    resp = await app.request("/api/v1/admin/keys", { headers: { Authorization: `Bearer ${userToken}` } }, env)
    expect(resp.status).toBe(401)
    resp = await app.request("/api/v1/admin/keys", { headers: { Authorization: "Bearer not-a-jwt" } }, env)
    expect(resp.status).toBe(401)
  })

  it("JWT_SECRET 缺失时 admin JWT 无法校验 → 401（不 500）", async () => {
    const { db } = makeDb({ auditRows: [] })
    const signing = makeEnv()
    const token = await jwt(signing, "admin")
    const env = makeEnv({ DB: db, ADMIN_API_KEY: undefined, JWT_SECRET: undefined })
    const resp = await app.request("/api/v1/admin/keys", { headers: { Authorization: `Bearer ${token}` } }, env)
    expect(resp.status).toBe(401)
  })

  it("?actor= 仍可覆盖审计 actor（运维通道旧行为不变）", async () => {
    const { db, calls } = makeDb({ auditRows: [] })
    const env = makeEnv({ DB: db })
    const resp = await app.request(
      "/api/v1/admin/accounts/acc-2/ban?actor=ops-1&reason=abuse",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      env,
    )
    expect(resp.status).toBe(200)
    const ban = auditInserts(calls).find((c) => c.args[2] === "ban")!
    expect(ban.args[1]).toBe("ops-1")
    expect(ban.args[3]).toBe("acc-2")
    expect(ban.args[4]).toBe("reason=abuse")
  })
})
