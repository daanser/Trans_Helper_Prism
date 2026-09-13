// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 开业酬宾**路由级**单测（plan-promo.md §7 验收 1/2/3/5/7/8/9）
//
// 覆盖（全 mock：D1 内存 + fetch stub；零网络）：
//   ① 登录用户走促销链 → key_usage 记 pool='ds' + ref 'ds-pool-key-0' + **真实 usage** + 自算 cost；
//   ② 匿名**永远走免费链**（促销仅登录用户，后端与前端一致）；
//   ③ 促销 KV flag 关掉 → 自动回退免费链，用户只看到一行提示（不静默降级）；
//   ④ 促销上游 401（key 坏/欠费）→ 回退免费链 **且立刻把促销闸门关进 KV**；
//   ⑤ 预算耗尽 → 状态判定为 budget-exhausted → 直接走免费链；
//   ⑥ 请求体**只含上游认识的字段**（促销网关严格校验未知字段：thinking_budget → 400 UNKNOWN_FIELD）；
//   ⑦ 深度思考开关：`thinking=true` → 请求体 enable_thinking=true；默认 false；
//   ⑧ 额度 4×：促销配置生效时 limitTokens = 1M（/me 的 quota.limit_tokens 可证）。
import { describe, it, expect, afterEach, vi } from "vitest"
import { withBatch } from "./d1MockBatch"
import { app, makeKeyUsageDb } from "../src/index"
import { issueSession } from "../src/auth"
import { PROMO_KV_KEY, promoCostCny, resetPromoCache } from "../src/promo"
import type { Env } from "../src/types"
import { poolKeysEnv } from "./poolKeysEnv"

const DS_ENV = { DS_POOL_KEY_0: "ds-secret-a", DS_POOL_KEY_1: "ds-secret-b" }
const JWT_SECRET = "t".repeat(64)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetPromoCache()
})

/** 记录 SQL/bind 的 D1 mock（key_usage 插入行可断言）；quota 行用于 /me。 */
function makeDb(opts: { quota?: Record<string, unknown>; chatRow?: Record<string, unknown> } = {}) {
  const inserts: unknown[][] = []
  const anchor = Date.now() - 3 * 3600_000
  const raw = {
    prepare(sql: string) {
      let args: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) {
          args = a
          return stmt
        },
        async run() {
          if (/INSERT INTO key_usage/i.test(sql)) inserts.push(args)
          return { success: true, results: [], meta: { changes: 1 } }
        },
        async all() {
          return { success: true, results: [], meta: { changes: 1 } }
        },
        async first() {
          if (/FROM chat_sessions/i.test(sql)) return opts.chatRow ?? null
          if (/FROM accounts WHERE id/i.test(sql)) {
            return { status: "active", created_at: anchor, disclaimer_ack_at: null }
          }
          if (/SELECT period_start/i.test(sql)) {
            return { period_start: anchor, used_cost: 0, monthly_limit: 5, requests: 0, ...(opts.quota ?? {}) }
          }
          if (/SELECT created_at/i.test(sql)) return { created_at: anchor }
          return null
        },
      }
      return stmt
    },
  }
  return { db: withBatch(raw as unknown as { prepare: (sql: string) => unknown }) as unknown as D1Database, inserts }
}

/** 内存 KV（促销 flag 可预置）。 */
function makeKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value)
  })
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put,
  } as unknown as KVNamespace
  return { kv, store, put }
}

function makeEnv(db: D1Database, kv?: KVNamespace, over: Record<string, unknown> = {}): Env {
  return {
    DB: db,
    SEARCH_CACHE: kv as never,
    INGEST_QUEUE: undefined as never,
    JWT_SECRET,
    ...poolKeysEnv(["sk-free-a"]), // 免费链（合并池）
    ...DS_ENV, // 促销独立池
    LLM_MODEL: "Qwen/Qwen3.5-4B",
    ...over,
  } as unknown as Env
}

/** /chat 用的会话行（含初始 hits）。 */
const CHAT_ROW = {
  id: "sess-1",
  account_id: "acc-1",
  model_id: "default",
  corpora: '["mtf-wiki"]',
  round_count: 1,
  initial_hits: '[{"id":"p1","title":"激素治疗","url":"https://u/1","source":"mtf-wiki","text":"正文"}]',
  history: "[]",
  created_at: 1,
  updated_at: 1,
}

/** chat 上游 stub：记录请求体与 URL，返回带 usage 的补全（或按需失败）。 */
function stubChat(opts: { fail401?: boolean; usage?: Record<string, unknown> } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ url: String(url), body })
    if (opts.fail401 && String(url).includes("tokenrhythm")) {
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 })
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "结论 [来源1]" } }],
        usage: opts.usage ?? { prompt_tokens: 12, completion_tokens: 34, prompt_tokens_details: { cached_tokens: 4 } },
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  vi.stubGlobal("fetch", fetchImpl)
  return { calls, fetchImpl }
}

async function chat(env: Env, token: string, body: Record<string, unknown> = {}) {
  return app.request(
    "/api/v1/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: "sess-1", question: "还有什么注意点？", ...body }),
    },
    env,
  )
}

describe("① 登录用户走促销链：记账 pool='ds' + 真实 usage + 自算成本", () => {
  it("promo 开启 → 调 tokenrhythm、key_usage 记 ds/ds-pool-key-0/真实 token/cost", async () => {
    const { db, inserts } = makeDb({ chatRow: CHAT_ROW })
    const { kv } = makeKv()
    const env = makeEnv(db, kv)
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const { calls } = stubChat()

    const resp = await chat(env, token)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { text: string; model: string; tokens_in: number; tokens_out: number }
    expect(body.text).toContain("[来源1]")
    expect(body.model).toBe("deepseek-flash") // 促销模型（A3：登录用户默认走它）
    expect(body.tokens_in).toBe(12)
    expect(body.tokens_out).toBe(34)

    // 上游是促销端点
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain("tokenrhythm.studio")
    expect(JSON.stringify(calls[0].body)).not.toMatch(/ds-secret/)

    // 记账：pool='ds'、ref='ds-pool-key-0'、endpoint='chat'、真实 token、成本按 A1 单价自算
    expect(inserts).toHaveLength(1)
    const row = inserts[0]
    expect(row[1]).toBe("acc-1")
    expect(row[2]).toBe("ds")
    expect(row[3]).toBe("ds-pool-key-0")
    expect(row[4]).toBe("chat")
    expect(row[8]).toBe(12)
    expect(row[9]).toBe(34)
    // cost = (12-4)/1e6×2 + 4/1e6×0.04 + 34/1e6×8（与 promo.ts 的自算函数**逐位一致**，不手写近似值）
    expect(Number(row[11])).toBe(promoCostCny({ promptTokens: 12, cachedTokens: 4, completionTokens: 34 }))
    expect(JSON.stringify(row)).not.toMatch(/ds-secret/)
  })

  it("⑦ 深度思考：默认不带 enable_thinking=true；thinking=true 时显式开启且请求体只含认识的字段", async () => {
    const { db } = makeDb({ chatRow: CHAT_ROW })
    const { kv } = makeKv()
    const env = makeEnv(db, kv)
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const { calls } = stubChat()

    await chat(env, token)
    expect(calls[0].body.enable_thinking).toBe(false)
    // 促销网关严格校验未知字段（实测 thinking_budget → 400 UNKNOWN_FIELD）→ 只允许这几个键；
    // 尤其**不能**出现 thinking_budget / reasoning_effort（前者直接 400，后者实测无效 —— plan §3/§5.5）
    expect(Object.keys(calls[0].body).sort()).toEqual(["enable_thinking", "max_tokens", "messages", "model", "stream"].sort())
    expect(calls[0].body.thinking_budget).toBeUndefined()
    expect(calls[0].body.reasoning_effort).toBeUndefined()
    expect(calls[0].body.max_tokens).toBe(4000) // A7：促销 4000

    await chat(env, token, { thinking: true })
    expect(calls[1].body.enable_thinking).toBe(true)
  })
})

describe("② 匿名永远走免费链（促销仅登录用户）", () => {
  it("/chat 无 Authorization → 401（本来就要登录）；/me 也无促销入口", async () => {
    const { db } = makeDb()
    const { kv } = makeKv()
    const env = makeEnv(db, kv)
    const resp = await app.request(
      "/api/v1/chat",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "s", question: "q" }) },
      env,
    )
    expect(resp.status).toBe(401)
  })

  it("/me 未登录 → 401（促销状态只对登录用户暴露）", async () => {
    const { db } = makeDb()
    const env = makeEnv(db, makeKv().kv)
    const resp = await app.request("/api/v1/me", {}, env)
    expect(resp.status).toBe(401)
  })
})

describe("③/④/⑤ 回退与收闸（用户无感失败，但不静默降级）", () => {
  it("KV flag 关掉 → 走免费链（Qwen），响应带 promo_downgraded 提示", async () => {
    const { db, inserts } = makeDb({ chatRow: CHAT_ROW })
    const { kv } = makeKv({ [PROMO_KV_KEY]: JSON.stringify({ enabled: false, started_at: 1 }) })
    const env = makeEnv(db, kv)
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const { calls } = stubChat()

    const resp = await chat(env, token)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { model: string; notice?: string; promo_downgraded?: boolean }
    expect(body.model).toBe("Qwen/Qwen3.5-4B")
    expect(body.promo_downgraded).toBeUndefined() // flag 关 = 正常走免费链，不算"降级"
    expect(calls[0].url).toContain("siliconflow")
    expect(inserts[0][2]).toBe("llm") // 免费链记 llm 池
  })

  it("⑤ 预算耗尽（KV 累计 ≥ 预算）→ 不再尝试促销，直接免费链", async () => {
    const { db, inserts } = makeDb({ chatRow: CHAT_ROW })
    const { kv } = makeKv({ [PROMO_KV_KEY]: JSON.stringify({ started_at: 1, spent_cny: 999 }) })
    const env = makeEnv(db, kv)
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const { calls } = stubChat()

    const resp = await chat(env, token)
    expect(resp.status).toBe(200)
    expect(calls[0].url).toContain("siliconflow")
    expect(inserts[0][2]).toBe("llm")
  })

  it("④ 促销上游 401 → 自动回退免费链 + **把促销闸门写进 KV**（下次不再尝试）", async () => {
    const { db, inserts } = makeDb({ chatRow: CHAT_ROW })
    const { kv, store } = makeKv()
    const env = makeEnv(db, kv)
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const { calls } = stubChat({ fail401: true })

    const resp = await chat(env, token)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { model: string; promo_downgraded?: boolean; notice?: string }
    expect(body.model).toBe("Qwen/Qwen3.5-4B")
    expect(body.promo_downgraded).toBe(true)
    expect(body.notice).toContain("已切回标准模型")

    // 上游调用：促销 401 → **换第二把 DS key 重试**（401 属可换 key 状态）→ 仍 401 → 回退免费链
    expect(calls.map((c) => (c.url.includes("tokenrhythm") ? "ds" : "free"))).toEqual(["ds", "ds", "free"])
    // 记账：促销两条失败行（两把 key 都试过，便于排查是哪把坏了）+ 免费成功一行
    expect(inserts.map((r) => r[2])).toEqual(["ds", "ds", "llm"])
    expect(inserts.filter((r) => r[2] === "ds").map((r) => r[3])).toEqual(["ds-pool-key-0", "ds-pool-key-1"])
    // 闸门已落 KV（紧急关闭/欠费收闸都不需要重新部署）
    const flag = JSON.parse(store.get(PROMO_KV_KEY) ?? "{}") as { enabled?: boolean; note?: string }
    expect(flag.enabled).toBe(false)
    expect(flag.note).toContain("401")
  })
})

describe("⑧ 额度 4×（促销配置生效时 1M）", () => {
  it("/me 的 quota.limit_tokens = 1M，并回促销状态供前端决定是否显示入口", async () => {
    const { db } = makeDb()
    const { kv } = makeKv()
    const env = makeEnv(db, kv)
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })

    const resp = await app.request("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } }, env)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      quota: { limit_tokens: number }
      promo: { enabled: boolean; model: string; thinking_available: boolean; quota_window_tokens: number | null }
    }
    expect(body.quota.limit_tokens).toBe(1_000_000)
    expect(body.promo).toMatchObject({
      enabled: true,
      model: "deepseek-flash",
      thinking_available: true,
      quota_window_tokens: 1_000_000,
    })
  })

  it("没配 DS key → 促销关闭（no-keys）、额度回 300k（不给匿名/未配置环境放大额度）", async () => {
    const { db } = makeDb()
    const env = makeEnv(db, makeKv().kv, { DS_POOL_KEY_0: undefined, DS_POOL_KEY_1: undefined })
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const resp = await app.request("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } }, env)
    const body = (await resp.json()) as { quota: { limit_tokens: number }; promo: { enabled: boolean; reason: string } }
    expect(body.quota.limit_tokens).toBe(300_000)
    expect(body.promo).toMatchObject({ enabled: false, reason: "no-keys" })
  })

  it("PROMO_ENABLED=false → 促销关且额度回 300k（同步生效，无需等 KV）", async () => {
    const { db } = makeDb()
    const env = makeEnv(db, makeKv().kv, { PROMO_ENABLED: "false" })
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const resp = await app.request("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } }, env)
    const body = (await resp.json()) as { quota: { limit_tokens: number }; promo: { enabled: boolean; reason: string } }
    expect(body.quota.limit_tokens).toBe(300_000)
    expect(body.promo).toMatchObject({ enabled: false, reason: "disabled-by-env" })
  })
})

describe("记账 db 的 ds 池接线（makeKeyUsageDb）", () => {
  it("recordUsage(pool='ds') 写入 key_usage 且 cost 列有值", async () => {
    const { db, inserts } = makeDb()
    const usageDb = makeKeyUsageDb({ DB: db } as unknown as Env, "acc-9")
    await usageDb.recordUsage({
      pool: "ds",
      keyRef: "ds-pool-key-1",
      endpoint: "chat",
      model: "deepseek-flash",
      status: "ok",
      tokensIn: 100,
      tokensOut: 50,
      cost: 0.0006,
    })
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1]).toBe("acc-9")
    expect(inserts[0][2]).toBe("ds")
    expect(inserts[0][11]).toBe(0.0006)
  })
})

// ─────────────────────────────────────────────
// /search/stream（前端实际使用的路径）：促销优先 + 真实 usage + 失败静默回退 + notice
// ─────────────────────────────────────────────

/** 促流式上游 stub：SSE 分块（内容块 + 末块 usage）。 */
function stubStream(opts: { fail401?: boolean } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    calls.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
    if (u.includes("/points/search")) {
      return new Response(
        JSON.stringify({
          result: [
            { id: "p1", score: 0.9, payload: { title: "激素治疗", text: "正文", url: "https://u/1", path: "p1", wiki_id: "mtf-wiki" } },
          ],
        }),
        { status: 200 },
      )
    }
    if (u.includes("/v1/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(8).fill(0.1) }] }), { status: 200 })
    }
    if (opts.fail401 && u.includes("tokenrhythm")) {
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 })
    }
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "结论" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " [来源1]" } }] })}\n\n`,
      // 末块：只有 usage（促销链带了 stream_options.include_usage）
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 12 } },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]
    return new Response(chunks.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }) as unknown as typeof fetch
  vi.stubGlobal("fetch", fetchImpl)
  return { calls }
}

function streamEnv(db: D1Database, kv: KVNamespace) {
  return {
    DB: db,
    SEARCH_CACHE: kv,
    INGEST_QUEUE: undefined as never,
    JWT_SECRET,
    ...poolKeysEnv(["sk-free-a"]),
    ...DS_ENV,
    QDRANT_URL: "https://qdrant.example",
    EMBEDDING_DIM: "8",
    REQUIRE_LOGIN: "0",
  } as unknown as Env
}

async function streamSearch(env: Env, token: string, body: Record<string, unknown> = {}) {
  return app.request(
    "/api/v1/search/stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: "激素", corpora: ["mtf-wiki"], use_llm: true, top_k: 3, ...body }),
    },
    env,
  )
}

describe("/search/stream 促销路径", () => {
  it("登录 + 促销开 → 流式用 deepseek-flash、末块 usage 落到 pool='ds'、成本自算", async () => {
    const { db, inserts } = makeDb()
    const { kv } = makeKv()
    const env = streamEnv(db, kv)
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const { calls } = stubStream()

    const resp = await streamSearch(env, token, { thinking: true })
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toContain('event: delta')
    expect(text).toContain('"model":"deepseek-flash"')
    expect(text).toContain('"llm":true')

    // 促销上游拿到的是"开思考 + include_usage"的干净请求体
    const dsCall = calls.find((c) => c.url.includes("tokenrhythm"))!
    expect(dsCall.body.enable_thinking).toBe(true)
    expect(dsCall.body.max_tokens).toBe(4000)
    expect(dsCall.body.stream_options).toEqual({ include_usage: true })
    expect(Object.keys(dsCall.body).sort()).toEqual(
      ["enable_thinking", "max_tokens", "messages", "model", "stream", "stream_options"].sort(),
    )

    // 记账：真实 usage（20 in / 40 out，含 8 命中）+ 按单价自算的 cost
    const dsRow = inserts.find((r) => r[2] === "ds")!
    expect(dsRow[3]).toBe("ds-pool-key-0")
    expect(dsRow[8]).toBe(20)
    expect(dsRow[9]).toBe(40)
    expect(Number(dsRow[11])).toBe(promoCostCny({ promptTokens: 20, cachedTokens: 8, completionTokens: 40 }))
  })

  it("促销上游 401 → 流内 emit notice 并**改走免费链**（用户拿到免费模型的总结）", async () => {
    const { db, inserts } = makeDb()
    const { kv } = makeKv()
    const env = streamEnv(db, kv)
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    const { calls } = stubStream({ fail401: true })

    const resp = await streamSearch(env, token)
    const text = await resp.text()
    expect(text).toContain("promo-unavailable") // 不静默降级：明确告诉前端已切回标准模型
    expect(text).toContain("已切回标准模型")
    expect(text).toContain('"model":"Qwen/Qwen3.5-4B"')
    expect(calls.some((c) => c.url.includes("siliconflow"))).toBe(true)
    expect(inserts.some((r) => r[2] === "llm")).toBe(true)
  })
})
