// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — key_usage 记账的**账号归属**单测（/admin/usage 真值的地基）
//
// 覆盖：makeKeyUsageDb(env, accountId) 把 account_id 写进 key_usage；匿名（无 session）= 空串，
//       仍照记账；列顺序/字段映射与 schema.sql 一致；缺 D1 或写库失败绝不抛错（记账不阻断业务）；
//       以及**真路由接线**：/search（登录 / 匿名）把账号作用域的 usage db 传进检索链路，
//       而 /chat 的 LLM 调用确实把 account_id 落到 key_usage（端到端）。
// 全 mock D1 + mock fetch（embeddings/Qdrant/LLM），零网络。
import { describe, it, expect, afterEach, vi } from "vitest"
import { app, makeKeyUsageDb } from "../src/index"
import { issueSession } from "../src/auth"
import type { Env } from "../src/types"
import type { KeyPoolDb, UsageRecord } from "../src/keypool"

// 捕获 runSearch 交给 embedding provider 的 KeyPoolDb（见下方 /search 接线用例）。
// 注意：embeddings.ts 目前**只持有**这个 db、从不调 recordUsage（key_usage 里只有 chat 行，
// 见交付报告「遗留与风险」），所以这里捕获后手动驱动 recordUsage 来验证接线是否正确。
const captured = vi.hoisted(() => ({ embedDbs: [] as unknown[] }))
vi.mock("../src/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embeddings")>()
  return {
    ...actual,
    createEmbeddingProvider: (...args: Parameters<typeof actual.createEmbeddingProvider>) => {
      captured.embedDbs.push(args[1])
      return actual.createEmbeddingProvider(...args)
    },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 记录 sql + bind 的 D1 mock；可选让 run() 抛错。 */
function makeDb(opts: { failRun?: boolean } = {}) {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.args = args
          return stmt
        },
        async run() {
          calls.push({ sql, args: stmt.args })
          if (opts.failRun) throw new Error("d1-write-failed")
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
  return { db, calls }
}

function makeEnv(db?: D1Database): Env {
  return { DB: db as never, SEARCH_CACHE: undefined as never, INGEST_QUEUE: undefined as never } as unknown as Env
}

const REC: UsageRecord = {
  pool: "llm",
  keyRef: "llm-key-0",
  endpoint: "chat",
  model: "Qwen/Qwen3.5-4B",
  status: "ok",
  statusCode: 200,
  tokensIn: 11,
  tokensOut: 22,
  latencyMs: 1234,
  cost: 0,
}

/** INSERT 的列顺序（与实现保持一致，便于按位置断言）。 */
const COLUMNS = [
  "id",
  "account_id",
  "pool",
  "key_ref",
  "endpoint",
  "model",
  "status",
  "status_code",
  "tokens_in",
  "tokens_out",
  "latency_ms",
  "cost",
  "created_at",
]

describe("makeKeyUsageDb 的账号归属", () => {
  it("带 accountId → 写入该账号；列顺序与 schema.sql 一致；字段一一对应", async () => {
    const { db, calls } = makeDb()
    await makeKeyUsageDb(makeEnv(db), "acc-1").recordUsage(REC)

    expect(calls).toHaveLength(1)
    const { sql, args } = calls[0]
    expect(sql).toContain("INSERT INTO key_usage")
    for (const col of COLUMNS) expect(sql).toContain(col)
    expect(sql.indexOf("account_id")).toBeLessThan(sql.indexOf("pool")) // 列序：id, account_id, pool, …

    expect(args).toHaveLength(COLUMNS.length)
    expect(args[1]).toBe("acc-1") // account_id
    expect(args[2]).toBe("llm")
    expect(args[3]).toBe("llm-key-0")
    expect(args[4]).toBe("chat")
    expect(args[5]).toBe("Qwen/Qwen3.5-4B")
    expect(args[6]).toBe("ok")
    expect(args[7]).toBe(200)
    expect(args[8]).toBe(11)
    expect(args[9]).toBe(22)
    expect(args[10]).toBe(1234)
    expect(typeof args[0]).toBe("string") // id = randomUUID
    expect(args[0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("匿名（无 session / 未传 accountId）→ account_id 记空串，仍照记账", async () => {
    const { db, calls } = makeDb()
    await makeKeyUsageDb(makeEnv(db)).recordUsage(REC)
    await makeKeyUsageDb(makeEnv(db), undefined).recordUsage({ ...REC, endpoint: "embeddings", pool: "embed" })

    expect(calls).toHaveLength(2)
    expect(calls[0].args[1]).toBe("") // 匿名 = 空串（不是 null / 不是省略）
    expect(calls[1].args[1]).toBe("")
  })

  it("可选字段缺省时回落（model '' / statusCode null / tokens 0 / cost 0），绝不写 undefined", async () => {
    const { db, calls } = makeDb()
    await makeKeyUsageDb(makeEnv(db), "acc-2").recordUsage({
      pool: "embed",
      keyRef: "embed-key-0",
      endpoint: "embeddings",
      model: "",
      status: "failed",
    })
    const args = calls[0].args
    expect(args[7]).toBeNull() // statusCode
    expect(args[8]).toBe(0) // tokens_in
    expect(args[9]).toBe(0) // tokens_out
    expect(args[10]).toBeNull() // latency_ms
    expect(args[11]).toBe(0) // cost
    expect(args.every((a) => a !== undefined)).toBe(true)
  })

  it("缺 D1 → 静默 no-op（不抛、不写）", async () => {
    const { calls } = makeDb()
    await expect(makeKeyUsageDb(makeEnv(), "acc-1").recordUsage(REC)).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it("写库失败 → 吞掉不阻断面业务（不抛）", async () => {
    const { db } = makeDb({ failRun: true })
    await expect(makeKeyUsageDb(makeEnv(db), "acc-1").recordUsage(REC)).resolves.toBeUndefined()
  })

  it("绝不把 secret 写进 SQL/参数（只有 key_ref）", async () => {
    const { db, calls } = makeDb()
    await makeKeyUsageDb(makeEnv(db), "acc-1").recordUsage(REC)
    expect(JSON.stringify(calls)).not.toMatch(/sk-/)
    expect(calls[0].sql).not.toMatch(/secret|api_key|key_value/i)
  })
})


// ── 真路由接线 ──

/** 记录 INSERT INTO key_usage 的 bind 参数；`first()` 供 chat_sessions 用。 */
function makeRouteDb(chatRow: Record<string, unknown> | null = null) {
  const inserts: unknown[][] = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.args = args
          return stmt
        },
        async run() {
          if (/INSERT INTO key_usage/i.test(sql)) inserts.push(stmt.args)
          return { success: true, results: [], meta: { changes: 1 } }
        },
        async all() {
          return { success: true, results: [], meta: { changes: 0 } }
        },
        async first() {
          if (/FROM chat_sessions/i.test(sql)) return chatRow
          return null
        },
      }
      return stmt
    },
    async batch(stmts: unknown[]) {
      return stmts
    },
  } as unknown as D1Database
  return { db, inserts }
}

/** fetch mock：embeddings / Qdrant 检索 / LLM chat completions（全部本地 mock，零网络）。 */
function stubFetch() {
  const fetchImpl = vi.fn(async (url: unknown): Promise<Response> => {
    const u = String(url)
    if (u.includes("/v1/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(8).fill(0.1) }] }), { status: 200 })
    }
    if (u.includes("/points/search")) {
      return new Response(
        JSON.stringify({
          result: [{ id: "p1", score: 0.9, payload: { title: "激素治疗", text: "正文", url: "https://u/1" } }],
        }),
        { status: 200 },
      )
    }
    // LLM（OpenAI 兼容 chat/completions）
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "根据资料……[来源1]" } }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      }),
      { status: 200 },
    )
  })
  vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch)
}

function routeEnv(db: D1Database, over: Partial<Env> = {}): Env {
  return {
    DB: db,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    QDRANT_URL: "https://qdrant.example",
    QDRANT_API_KEY: "qdrant-test-key",
    EMBED_POOL_KEYS: "sk-fake-embed-0001,sk-fake-embed-0002",
    LLM_POOL_KEYS: "sk-fake-llm-0001",
    EMBEDDING_DIM: "8",
    REQUIRE_LOGIN: "0", // 匿名也走完整检索（否则提前 fallback，不产生 embedding 调用）
    JWT_SECRET: "j".repeat(64),
    ...over,
  } as unknown as Env
}

function searchInit(authorization?: string) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify({ query: "激素", corpora: ["mtf-wiki"], use_reranker: false, top_k: 3 }),
  }
}

describe("POST /api/v1/search：账号作用域的 usage db 接线", () => {
  it("登录用户 → 传给检索链路的 KeyPoolDb 按该账号记账", async () => {
    const { db, inserts } = makeRouteDb()
    const env = routeEnv(db)
    stubFetch()
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })
    captured.embedDbs.length = 0

    const resp = await app.request("/api/v1/search", searchInit(`Bearer ${token}`), env)
    expect(resp.status).toBe(200)

    expect(captured.embedDbs).toHaveLength(1)
    const usageDb = captured.embedDbs[0] as KeyPoolDb
    await usageDb.recordUsage({
      pool: "embed",
      keyRef: "embed-key-0",
      endpoint: "embeddings",
      model: "BAAI/bge-m3",
      status: "ok",
      statusCode: 200,
      tokensIn: 7,
    })
    // 检索链路自身现在也会记账（embeddings/rerank 已挂 recordUsage），再加上本次手工那一行。
    expect(inserts.length).toBeGreaterThanOrEqual(2)
    for (const row of inserts) expect(row[1]).toBe("acc-1") // 全部归属该账号
    expect(inserts.some((row) => row[4] === "embeddings")).toBe(true)
    expect(JSON.stringify(inserts)).not.toMatch(/sk-/)
  })

  it("匿名 → 同一个 db 仍记账，account_id 记空串", async () => {
    const { db, inserts } = makeRouteDb()
    stubFetch()
    captured.embedDbs.length = 0

    const resp = await app.request("/api/v1/search", searchInit(), routeEnv(db))
    expect(resp.status).toBe(200)

    expect(captured.embedDbs).toHaveLength(1)
    await (captured.embedDbs[0] as KeyPoolDb).recordUsage({
      pool: "embed",
      keyRef: "embed-key-0",
      endpoint: "embeddings",
      model: "BAAI/bge-m3",
      status: "ok",
    })
    expect(inserts.length).toBeGreaterThanOrEqual(2)
    for (const row of inserts) expect(row[1]).toBe("") // 匿名一律空串
    expect(inserts.some((row) => row[4] === "embeddings")).toBe(true)
  })
})

describe("POST /api/v1/chat：LLM 记账落到账号（端到端）", () => {
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

  it("带 JWT 的 /chat → key_usage 写 account_id=sub、endpoint=chat、真实 token", async () => {
    const { db, inserts } = makeRouteDb(CHAT_ROW)
    const env = routeEnv(db)
    stubFetch()
    const token = await issueSession(env, { sub: "acc-1", handle: "u", role: "user" })

    const resp = await app.request(
      "/api/v1/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: "sess-1", question: "还有什么注意点？" }),
      },
      env,
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { text: string; tokens_in: number; tokens_out: number }
    expect(body.text).toContain("[来源1]")
    expect(body.tokens_in).toBe(12)
    expect(body.tokens_out).toBe(34)

    // 记账归属：llm 池的 key_ref + account_id = JWT sub
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1]).toBe("acc-1")
    expect(inserts[0][2]).toBe("llm")
    expect(inserts[0][3]).toBe("llm-key-0")
    expect(inserts[0][4]).toBe("chat")
    expect(inserts[0][8]).toBe(12)
    expect(inserts[0][9]).toBe(34)
    expect(JSON.stringify(inserts[0])).not.toMatch(/sk-/)
  })
})
