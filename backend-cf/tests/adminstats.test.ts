// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — admin 用量/Key 池接口单测（tasks.md T3.3 / T3.6）
// 全 mock：D1（记录 SQL+bind）、KV（内存，可注入失败）、JWT（真实签发，无网络）。零网络。
// 覆盖：
//   ① /admin/usage 聚合与 limitTokens(env) 一致、封禁状态、窗口过期、缺 D1 → 503；
//   ② /admin/usage 的 key_usage 账号维度真值（requests / llm_tokens_in / llm_tokens_out）：
//      窗口外不计、匿名不计、endpoint!='chat' 不计 token、无数据为 0；
//   ③ /admin/keys 只出 ref（**响应 JSON 里不得出现 sk- 形状**）、pools 与 env 一致、DB 空 → 空数组；
//   ④ POST /admin/keys 的 upsert + 审计（key_enable/key_disable、target=key_ref）+ KV 运行时效；
//   ⑤ POST /admin/db/apply-schema 的迁移容错（duplicate column name / 全新库 no such table → 成功；
//      其它错误 → failed + 207）；
//   ⑥ admin 鉴权二选一：ADMIN_API_KEY 或 JWT role=admin（含「未配 key + JWT admin → 放行」）。
import { describe, it, expect, vi, afterEach } from "vitest"
import { app } from "../src/index"
import { issueSession } from "../src/auth"
import { KEY_DENY_PREFIX } from "../src/keyadmin"
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from "../src/db/schemaStatements"
import { aggregateKeyUsage, resolveWindowStart } from "../src/adminstats"
import type { Env } from "../src/types"

afterEach(() => {
  vi.restoreAllMocks()
})

/** 明显假的占位 secret（绝不是真 key）：只用于「不得出现在响应里」的断言。 */
const EMBED_SECRETS = ["sk-fake-embed-0001", "sk-fake-embed-0002"]
const LLM_SECRETS = ["sk-fake-llm-0001"]

const NOW = Date.now()
/** 默认 fixture 的窗口起点（= 1 小时前；QUOTA_WINDOW_HOURS=5 → 窗口内）。 */
const WINDOW_START = NOW - 3_600_000

/** D1 mock：按 SQL 形状返回预置行，并记录每次 bind 的 sql+args。 */
function makeDb(
  opts: {
    usageRows?: unknown[]
    keyUsageRows?: unknown[]
    keyRows?: unknown[]
    auditRows?: unknown[]
    fail?: "usage" | "keyusage" | "keys" | "all"
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
          if (/FROM key_usage/i.test(sql)) {
            if (opts.fail === "keyusage" || opts.fail === "all") throw new Error("d1-failed")
            return { success: true, results: opts.keyUsageRows ?? [], meta: { changes: 0 } }
          }
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

/**
 * 默认 usage 行（acc-1 正常 / acc-2 超额 / acc-3 封禁且无 quotas 行）。
 * `requests` 是技术债 #4 新增的 `quotas.requests` 列 = **本窗口内扣费成功的真实请求数**
 * （与 `key_usage` 行数无关；老口径以 `upstream_calls` 透出）。
 */
function usageRows() {
  return [
    {
      account_id: "acc-1",
      status: "active",
      created_at: NOW - 60_000,
      period_start: WINDOW_START,
      used_cost: 250,
      requests: 7,
    },
    {
      account_id: "acc-2",
      status: "active",
      created_at: NOW - 50_000,
      period_start: WINDOW_START,
      used_cost: 1500, // 超限 → used_pct 夹到 100
      requests: 3,
    },
    {
      account_id: "acc-3",
      status: "banned",
      created_at: NOW - 40_000,
      period_start: null, // 无 quotas 行（LEFT JOIN → NULL）
      used_cost: null,
      requests: null,
    },
  ]
}

/**
 * key_usage 窗口粗筛行（account_id / endpoint / tokens_in / tokens_out / created_at）。
 * 期望结果（`upstream_calls` = 老口径的 key_usage 行数；`requests` 另见 usageRows 的 quotas.requests）：
 *   acc-1 → upstream_calls 4（embeddings + rerank + 2×chat）+ 窗口外/未来行不计
 *           llm_tokens_in 100 / out 200（只有 chat 累加：100/200 + 0/0）
 *   acc-2 → requests 1、in 10 / out 20
 *   acc-3 → 全 0（无 quotas 行 → 窗口起点 = now，任何历史行都不在窗口内）
 *   匿名（''）与未知账号（acc-gone）不计入任何 item
 */
function keyUsageRows() {
  return [
    { account_id: "acc-1", endpoint: "embeddings", tokens_in: 7, tokens_out: 0, created_at: WINDOW_START + 1_000 },
    { account_id: "acc-1", endpoint: "rerank", tokens_in: 5, tokens_out: 0, created_at: WINDOW_START + 2_000 },
    { account_id: "acc-1", endpoint: "chat", tokens_in: 100, tokens_out: 200, created_at: WINDOW_START + 3_000 },
    { account_id: "acc-1", endpoint: "chat", tokens_in: 0, tokens_out: 0, created_at: WINDOW_START + 4_000 },
    // 窗口外（早于 window_start 1ms）→ 不计入
    { account_id: "acc-1", endpoint: "chat", tokens_in: 999, tokens_out: 999, created_at: WINDOW_START - 1 },
    // 未来行（时钟回拨/写入异常）→ 不计入
    { account_id: "acc-1", endpoint: "chat", tokens_in: 888, tokens_out: 888, created_at: NOW + 60_000 },
    { account_id: "acc-2", endpoint: "chat", tokens_in: 10, tokens_out: 20, created_at: WINDOW_START + 5_000 },
    // 匿名调用：记了账但不归属账号
    { account_id: "", endpoint: "chat", tokens_in: 500, tokens_out: 500, created_at: WINDOW_START + 6_000 },
    // 已不存在的账号（不在本次 items 清单里）
    { account_id: "acc-gone", endpoint: "chat", tokens_in: 700, tokens_out: 700, created_at: WINDOW_START + 7_000 },
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
    const { db } = makeDb({ usageRows: usageRows(), keyUsageRows: keyUsageRows(), keyRows: keyRows() })
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
    expect(acc1.window_start).toBe(WINDOW_START)
    // requests = quotas.requests（真实请求数，技术债 #4 新口径）；
    // upstream_calls = key_usage 行数（老口径，含换 key 重试）—— 两者互相独立
    expect(acc1.requests).toBe(7)
    expect(acc1.upstream_calls).toBe(4)
    expect(acc1.llm_tokens_in).toBe(100)
    expect(acc1.llm_tokens_out).toBe(200)

    const acc2 = body.items.find((i) => i.account_id === "acc-2")!
    expect(acc2.used_pct).toBe(100) // 150% 夹到 100
    expect(acc2.remaining_pct).toBe(0)
    expect(acc2.exceeded).toBe(true)
    expect(acc2.requests).toBe(3)
    expect(acc2.upstream_calls).toBe(1)
    expect(acc2.llm_tokens_in).toBe(10)
    expect(acc2.llm_tokens_out).toBe(20)

    // 封禁账号：状态原样透出，且没有 quotas 行 → used 0
    const acc3 = body.items.find((i) => i.account_id === "acc-3")!
    expect(acc3.status).toBe("banned")
    expect(acc3.used_tokens).toBe(0)
    expect(acc3.used_pct).toBe(0)
    expect(acc3.exceeded).toBe(false)
    // 无 quotas 行 = 窗口起点是 now → 窗口内用量 0（不是 null）
    expect(acc3.window_start).toBeGreaterThanOrEqual(NOW)
    expect(acc3.requests).toBe(0) // 无 quotas 行 → 0
    expect(acc3.upstream_calls).toBe(0)
    expect(acc3.llm_tokens_in).toBe(0)
    expect(acc3.llm_tokens_out).toBe(0)

    // 三个数字现在是**真值**（number），不再有 null
    expect(body.items.every((i) => typeof i.requests === "number")).toBe(true)
    expect(body.items.every((i) => typeof i.llm_tokens_in === "number")).toBe(true)
    expect(body.items.every((i) => typeof i.llm_tokens_out === "number")).toBe(true)

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

// ────────── 账号维度真值：requests（quotas）/ upstream_calls 与 llm_tokens（key_usage）──────────

describe("/admin/usage 的账号维度真值（requests 来自 quotas，token 来自 key_usage）", () => {
  /** 跑一次 /admin/usage，返回 items（按 account_id 索引）+ D1 调用记录。 */
  async function fetchItems(opts: Parameters<typeof makeDb>[0], env: Partial<Env> = {}) {
    const { db, calls } = makeDb(opts)
    const resp = await app.request(
      "/api/v1/admin/usage",
      { headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db, ...env }),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      items: Array<{
        account_id: string
        used_tokens: number
        requests: number
        upstream_calls: number
        llm_tokens_in: number
        llm_tokens_out: number
        window_start: number
      }>
    }
    const byId = new Map(body.items.map((i) => [i.account_id, i]))
    return { byId, items: body.items, calls }
  }

  it("窗口内计数；窗口外/未来/匿名/未知账号不计；embed|rerank 只计调用不计 token", async () => {
    const { byId, calls } = await fetchItems({ usageRows: usageRows(), keyUsageRows: keyUsageRows() })

    // requests = quotas.requests（扣费成功的真实请求数，与 key_usage 无关）
    expect(byId.get("acc-1")!.requests).toBe(7)
    expect(byId.get("acc-2")!.requests).toBe(3)
    // upstream_calls = key_usage 行数（老口径）：embeddings + rerank + 2×chat（窗口外与未来行被剔除）
    expect(byId.get("acc-1")!.upstream_calls).toBe(4)
    expect(byId.get("acc-1")!.llm_tokens_in).toBe(100) // 只有 chat 的 100 计入（embeddings 7 / rerank 5 / 999 / 888 都不计）
    expect(byId.get("acc-1")!.llm_tokens_out).toBe(200)

    expect(byId.get("acc-2")!.upstream_calls).toBe(1)
    expect(byId.get("acc-2")!.llm_tokens_in).toBe(10)
    expect(byId.get("acc-2")!.llm_tokens_out).toBe(20)

    // 无 quotas 行的账号 = 新窗口（window_start 上移到 now）→ 历史行全在窗口外
    expect(byId.get("acc-3")!.requests).toBe(0)
    expect(byId.get("acc-3")!.upstream_calls).toBe(0)
    expect(byId.get("acc-3")!.llm_tokens_in).toBe(0)
    expect(byId.get("acc-3")!.llm_tokens_out).toBe(0)

    // 匿名（''）与已删除账号（acc-gone）不产生 item
    expect(byId.has("")).toBe(false)
    expect(byId.has("acc-gone")).toBe(false)
    expect(byId.size).toBe(3)
    // requests 走 accounts ⟕ quotas 的**同一条** JOIN（零额外查询）
    expect(calls.filter((c) => /FROM accounts/i.test(c.sql))).toHaveLength(1)
    expect(calls.find((c) => /FROM accounts/i.test(c.sql))!.sql).toContain("q.requests AS requests")
  })

  it("没有任何 key_usage 行 → token/upstream_calls 为 0；requests 只认 quotas", async () => {
    const { byId } = await fetchItems({ usageRows: usageRows(), keyUsageRows: [] })
    for (const item of byId.values()) {
      expect(item.upstream_calls).toBe(0)
      expect(item.llm_tokens_in).toBe(0)
      expect(item.llm_tokens_out).toBe(0)
    }
    expect(byId.get("acc-1")!.requests).toBe(7) // 不受 key_usage 影响（真值来自 quotas）
    expect(byId.get("acc-3")!.requests).toBe(0)
  })

  it("窗口已过期 → 只统计「新窗口」内的行（旧行归 0，requests 也归 0）", async () => {
    const rows = [
      {
        account_id: "acc-old",
        status: "active",
        created_at: 1,
        period_start: NOW - 6 * 3_600_000,
        used_cost: 900,
        requests: 5, // 旧窗口里扣费成功过 5 次 → 过期窗口一律按 0 呈现（与 used_cost 同口径）
      },
    ]
    const { byId, calls } = await fetchItems({
      usageRows: rows,
      keyUsageRows: [
        // 1 小时前 = 旧窗口内、新窗口（= now）外 → 不计
        { account_id: "acc-old", endpoint: "chat", tokens_in: 42, tokens_out: 43, created_at: NOW - 3_600_000 },
      ],
    })
    expect(byId.get("acc-old")!.used_tokens).toBe(0)
    expect(byId.get("acc-old")!.requests).toBe(0)
    expect(byId.get("acc-old")!.upstream_calls).toBe(0)
    expect(byId.get("acc-old")!.llm_tokens_in).toBe(0)
    expect(byId.get("acc-old")!.llm_tokens_out).toBe(0)
    // 粗筛下界 = 该账号（新窗口）起点；窗口外行由 JS 侧剔除，不依赖 SQL
    const usageQuery = calls.find((c) => /FROM key_usage/i.test(c.sql))!
    expect(usageQuery.args[0]).toBeGreaterThan(NOW - 1000)
  })

  it("无账号（accounts 空）→ 不发 key_usage 查询；有账号时只发一条（无 N+1）", async () => {
    const empty = await fetchItems({ usageRows: [] })
    expect(empty.items).toHaveLength(0)
    expect(empty.calls.some((c) => /FROM key_usage/i.test(c.sql))).toBe(false)

    const full = await fetchItems({ usageRows: usageRows(), keyUsageRows: keyUsageRows() })
    const usageQueries = full.calls.filter((c) => /FROM key_usage/i.test(c.sql))
    expect(usageQueries).toHaveLength(1)
    // SQL 里做了「排除匿名」的粗筛，且带时间下界/上界（窗口并集）
    expect(usageQueries[0].sql).toContain("account_id <> ''")
    expect(usageQueries[0].sql).toContain("created_at >= ?")
    expect(usageQueries[0].sql).toContain("created_at <= ?")
    expect(usageQueries[0].args).toEqual([WINDOW_START, expect.any(Number)])
    // 只读：整个请求不产生写语句
    expect(full.calls.every((c) => c.op === "all")).toBe(true)
  })
})

describe("aggregateKeyUsage（纯函数，窗口 / endpoint 口径）", () => {
  const NOW2 = 1_700_000_000_000
  const starts = new Map([["acc-1", NOW2 - 1_000]])

  it("窗口内 chat 行累加 token，embed/rerank 只算请求", () => {
    const agg = aggregateKeyUsage(
      [
        { account_id: "acc-1", endpoint: "chat", tokens_in: 10, tokens_out: 20, created_at: NOW2 - 500 },
        { account_id: "acc-1", endpoint: "embeddings", tokens_in: 999, tokens_out: 999, created_at: NOW2 - 400 },
        { account_id: "acc-1", endpoint: "rerank", tokens_in: 999, tokens_out: 0, created_at: NOW2 - 300 },
      ],
      starts,
      NOW2,
    )
    expect(agg.get("acc-1")).toEqual({ requests: 3, llm_tokens_in: 10, llm_tokens_out: 20 })
  })

  it("窗口外（早于起点 / 晚于 now）、匿名、未知账号、脏 created_at 均不计入", () => {
    const agg = aggregateKeyUsage(
      [
        { account_id: "acc-1", endpoint: "chat", tokens_in: 1, tokens_out: 1, created_at: NOW2 - 1_001 },
        { account_id: "acc-1", endpoint: "chat", tokens_in: 1, tokens_out: 1, created_at: NOW2 + 1 },
        { account_id: "", endpoint: "chat", tokens_in: 1, tokens_out: 1, created_at: NOW2 - 500 },
        { account_id: "acc-gone", endpoint: "chat", tokens_in: 1, tokens_out: 1, created_at: NOW2 - 500 },
        { account_id: "acc-1", endpoint: "chat", tokens_in: 1, tokens_out: 1, created_at: null },
      ],
      starts,
      NOW2,
    )
    // null 会被 Number(null)=0 视作 0（远早于窗口起点）→ 仍不计入
    expect(agg.get("acc-1")).toBeUndefined()
    expect(agg.size).toBe(0)
  })

  it("负数 / 小数 token 夹到非负整数；边界时刻（= window_start / = now）计入", () => {
    const agg = aggregateKeyUsage(
      [
        { account_id: "acc-1", endpoint: "chat", tokens_in: -5, tokens_out: 2.7, created_at: NOW2 - 1_000 },
        { account_id: "acc-1", endpoint: "chat", tokens_in: 3, tokens_out: "4", created_at: NOW2 },
      ],
      starts,
      NOW2,
    )
    expect(agg.get("acc-1")).toEqual({ requests: 2, llm_tokens_in: 3, llm_tokens_out: 6 })
  })

  it("resolveWindowStart 与 quota 口径一致：缺失/过期/未来 → now", () => {
    const env = { QUOTA_WINDOW_HOURS: "5" }
    const wms = 5 * 3_600_000
    expect(resolveWindowStart(NOW2 - 1_000, NOW2, env)).toBe(NOW2 - 1_000)
    expect(resolveWindowStart(NOW2 - wms, NOW2, env)).toBe(NOW2) // 恰好到期 = 新窗口
    expect(resolveWindowStart(null, NOW2, env)).toBe(NOW2)
    expect(resolveWindowStart(NOW2 + 1, NOW2, env)).toBe(NOW2) // 时钟回拨
  })
})

// ─────────────────────────── POST /admin/db/apply-schema ───────────────────────────

describe("POST /api/v1/admin/db/apply-schema（迁移容错）", () => {
  /** D1 mock：按语句内容决定抛什么错；`ran` 只记录 DDL 语句（ALTER/CREATE/**DROP**；审计 INSERT 不计入）。 */
  function makeSchemaDb(failFor: (sql: string) => string | null = () => null) {
    const ran: string[] = []
    const db = {
      prepare(sql: string) {
        const stmt = {
          args: [] as unknown[],
          bind(...args: unknown[]) {
            stmt.args = args
            return stmt
          },
          async run() {
            if (/^(ALTER|CREATE|DROP)/i.test(sql)) ran.push(sql)
            const msg = failFor(sql)
            if (msg) throw new Error(msg)
            return { success: true, results: [], meta: { changes: 1 } }
          },
          async all() {
            return { success: true, results: [], meta: { changes: 0 } }
          },
          async first() {
            return null
          },
        }
        return stmt
      },
      async batch(stmts: unknown[]) {
        return stmts
      },
    } as unknown as D1Database
    return { db, ran }
  }

  const TOTAL = SCHEMA_STATEMENTS.length + SCHEMA_MIGRATIONS.length
  const ALTER_ACCOUNT_ID = SCHEMA_MIGRATIONS[0]

  it("顺序：迁移语句先跑（线上老表先补列），随后才是幂等建表", async () => {
    const { db, ran } = makeSchemaDb()
    const resp = await app.request(
      "/api/v1/admin/db/apply-schema",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ok: boolean; applied: number; total: number; tolerated: unknown[]; failed: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.total).toBe(TOTAL)
    expect(body.applied).toBe(TOTAL)
    expect(body.tolerated).toEqual([])
    expect(body.failed).toEqual([])
    expect(ran[0]).toContain("ALTER TABLE key_usage ADD COLUMN account_id")
    expect(ran[0]).toBe(ALTER_ACCOUNT_ID)
    // 补列语句后面紧跟的建表/索引语句都在
    expect(ran.join("\n")).toContain("idx_key_usage_account_created")
  })

  it("已迁移/新库：ALTER 报 duplicate column name → 视为成功（tolerated，不 failed）", async () => {
    const { db, ran } = makeSchemaDb((sql) =>
      sql.startsWith("ALTER TABLE key_usage") ? "SQLITE_ERROR: duplicate column name: account_id" : null,
    )
    const resp = await app.request(
      "/api/v1/admin/db/apply-schema",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      ok: boolean
      applied: number
      tolerated: Array<{ stmt: string; error: string }>
      failed: unknown[]
    }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(TOTAL)
    expect(body.failed).toEqual([])
    expect(body.tolerated).toHaveLength(1)
    expect(body.tolerated[0].error).toContain("duplicate column name")
    expect(ran.length).toBe(TOTAL) // 容忍 = 继续跑完，不是中断
  })

  it("全新库：ALTER 报 no such table → 视为成功（随后 CREATE TABLE 自带该列）", async () => {
    const { db } = makeSchemaDb((sql) =>
      sql.startsWith("ALTER TABLE key_usage") ? "SQLITE_ERROR: no such table: key_usage" : null,
    )
    const resp = await app.request(
      "/api/v1/admin/db/apply-schema",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ok: boolean; tolerated: unknown[]; failed: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.tolerated).toHaveLength(1)
    expect(body.failed).toEqual([])
  })

  it("其它错误（如索引缺列）仍计入 failed → 207 ok:false（绝不假绿）", async () => {
    const { db } = makeSchemaDb((sql) =>
      sql.includes("idx_key_usage_account_created") ? "SQLITE_ERROR: no such column: account_id" : null,
    )
    const resp = await app.request(
      "/api/v1/admin/db/apply-schema",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(207)
    const body = (await resp.json()) as {
      ok: boolean
      applied: number
      tolerated: unknown[]
      failed: Array<{ stmt: string; error: string }>
    }
    expect(body.ok).toBe(false)
    expect(body.applied).toBe(TOTAL - 1)
    expect(body.tolerated).toEqual([])
    expect(body.failed).toHaveLength(1)
    expect(body.failed[0].error).toContain("no such column")
  })

  it("CREATE 语句报 no such table 不算容忍（只有 ALTER 容忍），仍 failed", async () => {
    const { db } = makeSchemaDb((sql) =>
      sql.includes("idx_key_usage_account_created") ? "SQLITE_ERROR: no such table: key_usage" : null,
    )
    const resp = await app.request(
      "/api/v1/admin/db/apply-schema",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: db }),
    )
    expect(resp.status).toBe(207)
    expect(((await resp.json()) as { failed: unknown[] }).failed).toHaveLength(1)
  })

  it("审计留痕（action=apply_schema，含 tolerated 计数）；缺 D1 → 503", async () => {
    const { db, ran } = makeSchemaDb()
    const auditRows: Array<{ sql: string; args: unknown[] }> = []
    const auditDb = {
      prepare(sql: string) {
        const stmt = {
          args: [] as unknown[],
          bind(...args: unknown[]) {
            stmt.args = args
            return stmt
          },
          async run() {
            if (/INSERT INTO audit_log/i.test(sql)) auditRows.push({ sql, args: stmt.args })
            if (/^(ALTER|CREATE|DROP)/i.test(sql)) ran.push(sql)
            return { success: true, results: [], meta: { changes: 1 } }
          },
          async all() {
            return { success: true, results: [], meta: { changes: 0 } }
          },
          async first() {
            return null
          },
        }
        return stmt
      },
      async batch(stmts: unknown[]) {
        return stmts
      },
    } as unknown as D1Database
    void db

    const resp = await app.request(
      "/api/v1/admin/db/apply-schema",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ DB: auditDb }),
    )
    expect(resp.status).toBe(200)
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].args[1]).toBe("admin") // actor（API key 通道）
    expect(auditRows[0].args[2]).toBe("apply_schema")
    expect(String(auditRows[0].args[4])).toContain(`tolerated=0 failed=0`)

    const missing = await app.request(
      "/api/v1/admin/db/apply-schema",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      makeEnv(),
    )
    expect(missing.status).toBe(503)
    expect(await missing.json()).toEqual({ error: "db-unconfigured" })
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
