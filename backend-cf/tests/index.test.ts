// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — index.ts 路由接线单测 (tasks.md T2.2/T2.4)
// 全 mock fetch（Qdrant collection info / scroll），验证 /api/v1/corpora、/api/v1/tree/:wiki_id 的
// 200/422/404 路径与 queue consumer 的 wikiId 分发。绝不调真实上游。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { withBatch } from "./d1MockBatch"
import { app } from "../src/index"
import { issueSession } from "../src/auth"
import type { Env } from "../src/types"
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS, isToleratedSchemaError } from "../src/db/schemaStatements"

/** 最小 Env（无 DB/queue 也不崩：路由只读 env.QDRANT_* 与 registry）。 */
function makeEnv(qdrant = true): Env {
  return {
    DB: undefined as never,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    QDRANT_URL: qdrant ? "https://qdrant.example" : undefined,
    QDRANT_API_KEY: "qdrant-test-key",
  } as unknown as Env
}

/** fetch mock：collection info + scroll。 */
function makeFetchMock(): { fetchImpl: typeof fetch } {
  const fetchImpl = vi.fn(async (url: unknown): Promise<Response> => {
    const u = String(url)
    if (u.includes("/collections/") && u.endsWith("/points/scroll")) {
      return new Response(
        JSON.stringify({
          result: {
            points: [
              {
                payload: {
                  title: "激素治疗",
                  section_path: "治疗/激素",
                  path: "p1",
                  url: "https://u/1",
                  updated_at: "2026-01-01T00:00:00Z",
                },
              },
              {
                payload: {
                  title: "术后护理",
                  section_path: "手术/术后",
                  path: "p2",
                  url: "https://u/2",
                  updated_at: "2026-01-02T00:00:00Z",
                },
              },
            ],
            next_page_offset: null,
          },
        }),
        { status: 200 },
      )
    }
    // /collections/{name} GET → points_count
    return new Response(JSON.stringify({ result: { points_count: 42 } }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl }
}

describe("GET /api/v1/corpora", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("返回四库 corpora，chunk_count 来自 Qdrant points_count", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/corpora", {}, makeEnv())
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { corpora: Array<{ id: string; chunk_count: number; name: string }> }
    expect(body.corpora).toHaveLength(4)
    const mtf = body.corpora.find((c) => c.id === "mtf-wiki")!
    expect(mtf.chunk_count).toBe(42)
    expect(mtf.name).toBe("MtF Wiki")
  })

  it("Qdrant 未配置 → 仍返回 200，chunk_count 归零", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/corpora", {}, makeEnv(false))
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { corpora: Array<{ chunk_count: number }> }
    expect(body.corpora.every((c) => c.chunk_count === 0)).toBe(true)
    // 未配置 Qdrant 时不该发任何网络请求
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/tree/:wiki_id", () => {
  it("合法 wiki → 200 + 树（按 section_path 聚合）", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/tree/mtf-wiki", {}, makeEnv())
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { wiki_id: string; tree: Array<{ title: string; children: unknown[] }> }
    expect(body.wiki_id).toBe("mtf-wiki")
    expect(body.tree.length).toBeGreaterThan(0)
    expect(body.tree[0].children.length).toBeGreaterThan(0) // 治疗/激素 是 治疗 → 激素 两级的子节点
  })

  it("非法 wiki → 422", async () => {
    const resp = await app.request("/api/v1/tree/not-a-wiki", {}, makeEnv())
    expect(resp.status).toBe(422)
    expect(await resp.json()).toEqual({ error: "invalid-corpus" })
  })

  it("Qdrant 未配置 → 502", async () => {
    const resp = await app.request("/api/v1/tree/mtf-wiki", {}, makeEnv(false))
    expect(resp.status).toBe(502)
  })
})

// ── GET /api/v1/me —— R6：quota 带上重置时刻（window_end / reset_at / reset_in_sec）──
describe("GET /api/v1/me（配额 + 重置时刻）", () => {
  const HOUR_MS = 3_600_000
  const WINDOW_MS = 5 * HOUR_MS
  const JWT_SECRET = "s".repeat(64)

  /** 极简 D1 假表：只实现 /me 走到的 3 条读（accounts 状态+已确认免责 / accounts.created_at / quotas 行）。 */
  function quotaEnv(createdAt: number, quota: { period_start: number; used_cost: number }, disclaimerAckAt: number | null = null) {
    const db = {
      prepare(sql: string) {
        return {
          bind: () => ({
            first: async () => {
              if (sql.includes("SELECT status, created_at, disclaimer_ack_at FROM accounts")) {
                return { status: "active", created_at: createdAt, disclaimer_ack_at: disclaimerAckAt }
              }
              if (sql.includes("SELECT created_at FROM accounts")) return { created_at: createdAt }
              if (sql.includes("SELECT period_start")) {
                return { period_start: quota.period_start, used_cost: quota.used_cost, monthly_limit: 5 }
              }
              return null
            },
            run: async () => ({ success: true, results: [], meta: { changes: 0 } }),
          }),
        }
      },
    }
    return {
      DB: withBatch(db as unknown as { prepare: (sql: string) => unknown }) as unknown as Env["DB"],
      JWT_SECRET,
    } as unknown as Env
  }

  async function callMe(env: Env) {
    const token = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
    const resp = await app.request("/api/v1/me", { headers: { Authorization: `Bearer ${token}` } }, env)
    expect(resp.status).toBe(200)
    return (await resp.json()) as {
      user: { account_id: string; created_at: number }
      quota: Record<string, number | boolean>
      quota_display: string
    }
  }

  it("quota 带 window_end / reset_at / reset_in_sec，且 reset_at === 注册时间 + k×5h（手算网格）", async () => {
    const now = Date.now()
    const CREATED = now - 6 * HOUR_MS // 注册 6h 前 → 网格点：CREATED / CREATED+5h / CREATED+10h
    const GRID_START = CREATED + 5 * HOUR_MS // 当前网格起点（= now - 1h）
    const body = await callMe(quotaEnv(CREATED, { period_start: GRID_START, used_cost: 60_000 }))

    expect(body.user.created_at).toBe(CREATED)
    expect(body.quota.window_start).toBe(GRID_START)
    expect(body.quota.window_end).toBe(GRID_START + WINDOW_MS)
    expect(body.quota.reset_at).toBe((CREATED + 2 * WINDOW_MS) as number) // 手算：下一个网格点
    expect(body.quota.reset_in_sec).toBeGreaterThan(4 * 3600 - 60)
    expect(body.quota.reset_in_sec).toBeLessThanOrEqual(4 * 3600)
    // 既有百分比口径不变
    expect(body.quota.used_pct).toBe(20)
    expect(body.quota.remaining_pct).toBe(80)
    expect(body.quota_display).toBe("20.0%")
  })

  it("网格推进后：/me 视图按新窗口（used 归零、reset_at 指向下一网格点）", async () => {
    const now = Date.now()
    const CREATED = now - 6 * HOUR_MS
    const body = await callMe(quotaEnv(CREATED, { period_start: CREATED, used_cost: 300_000 }))
    expect(body.quota.used_tokens).toBe(0)
    expect(body.quota.window_start).toBe(CREATED + 5 * HOUR_MS)
    expect(body.quota.reset_at).toBe(CREATED + 10 * HOUR_MS)
    expect(body.quota.remaining_pct).toBe(100)
  })

  it("无 Authorization → 401（不泄漏任何配额信息）", async () => {
    const env = quotaEnv(Date.now(), { period_start: Date.now(), used_cost: 0 })
    const resp = await app.request("/api/v1/me", {}, env)
    expect(resp.status).toBe(401)
    expect(await resp.json()).toEqual({ error: "unauthorized" })
  })
})

// ── /me/disclaimer（免责声明同意态：默认弹窗 + 可记住，跨设备不再弹）──
describe("免责声明同意态（GET /me + POST /me/disclaimer）", () => {
  const HOUR_MS = 3_600_000
  const JWT_SECRET = "d".repeat(64)
  const CREATED = Date.UTC(2026, 8, 11, 0, 0, 0)

  /**
   * 有状态的极简 D1 假表：
   *   · accounts 行（status/created_at/disclaimer_ack_at）+ quotas 行（供 getQuota 走通）
   *   · `UPDATE accounts SET disclaimer_ack_at = ?` 真的改状态 → 才能断言"写完 /me 就反映"
   *   · `changes` 可注入 0 → 模拟"会话有效但账号行已不存在"
   */
  function disclaimerEnv(seedAckAt: number | null = null, changes = 1) {
    const state = { ackAt: seedAckAt, updates: [] as Array<number | null> }
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes("SELECT status, created_at, disclaimer_ack_at FROM accounts")) {
                  return { status: "active", created_at: CREATED, disclaimer_ack_at: state.ackAt }
                }
                if (sql.includes("SELECT created_at FROM accounts")) return { created_at: CREATED }
                if (sql.includes("SELECT period_start")) {
                  return { period_start: CREATED + Math.floor((Date.now() - CREATED) / (5 * HOUR_MS)) * 5 * HOUR_MS, used_cost: 0, monthly_limit: 5 }
                }
                return null
              },
              async run() {
                if (sql.startsWith("UPDATE accounts SET disclaimer_ack_at")) {
                  const next = args[0] as number | null
                  state.updates.push(next)
                  if (changes === 1) state.ackAt = next
                  return { success: true, results: [], meta: { changes } }
                }
                return { success: true, results: [], meta: { changes: 0 } }
              },
            }
          },
        }
      },
    }
    return {
      env: {
        DB: withBatch(db as unknown as { prepare: (sql: string) => unknown }) as unknown as Env["DB"],
        JWT_SECRET,
      } as unknown as Env,
      state,
    }
  }

  async function token(env: Env) {
    return await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
  }
  async function getMe(env: Env, tok: string) {
    const resp = await app.request("/api/v1/me", { headers: { Authorization: `Bearer ${tok}` } }, env)
    return { status: resp.status, body: (await resp.json()) as Record<string, unknown> }
  }
  function ack(env: Env, tok: string, body?: unknown) {
    return app.request(
      "/api/v1/me/disclaimer",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      },
      env,
    )
  }

  it("/me：未确认 → disclaimer_ack_at=null + disclaimer_ack=false", async () => {
    const { env } = disclaimerEnv(null)
    const { status, body } = await getMe(env, await token(env))
    expect(status).toBe(200)
    expect(body.disclaimer_ack_at).toBeNull()
    expect(body.disclaimer_ack).toBe(false)
  })

  it("/me：已确认 → 回时间戳 + disclaimer_ack=true（跨设备不再弹的依据）", async () => {
    const AT = CREATED + 1234
    const { env } = disclaimerEnv(AT)
    const { body } = await getMe(env, await token(env))
    expect(body.disclaimer_ack_at).toBe(AT)
    expect(body.disclaimer_ack).toBe(true)
  })

  it("POST：未登录 → 401（不写库）", async () => {
    const { env, state } = disclaimerEnv(null)
    const resp = await app.request("/api/v1/me/disclaimer", { method: "POST" }, env)
    expect(resp.status).toBe(401)
    expect(await resp.json()).toEqual({ error: "unauthorized" })
    expect(state.updates).toHaveLength(0)
  })

  it("POST：空 body（ack 缺省 true）→ 写入 now，且 /me 立刻反映已确认", async () => {
    const { env, state } = disclaimerEnv(null)
    const tok = await token(env)
    const before = Date.now()
    const resp = await ack(env, tok)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ok: boolean; disclaimer_ack_at: number }
    expect(body.ok).toBe(true)
    expect(body.disclaimer_ack_at).toBeGreaterThanOrEqual(before)
    expect(body.disclaimer_ack_at).toBeLessThanOrEqual(Date.now())
    expect(state.updates).toEqual([body.disclaimer_ack_at])

    const after = await getMe(env, tok)
    expect(after.body.disclaimer_ack).toBe(true)
    expect(after.body.disclaimer_ack_at).toBe(body.disclaimer_ack_at)
  })

  it("POST：{ack:false} → 置 NULL（设置页重新打开提示），/me 反映未确认", async () => {
    const { env, state } = disclaimerEnv(CREATED)
    const tok = await token(env)
    const resp = await ack(env, tok, { ack: false })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true, disclaimer_ack_at: null })
    expect(state.updates).toEqual([null])
    expect((await getMe(env, tok)).body.disclaimer_ack).toBe(false)
  })

  it("POST：{ack:true} 与缺省等价（幂等，重复调用刷新时间戳）", async () => {
    const { env, state } = disclaimerEnv(CREATED)
    const tok = await token(env)
    const body = (await (await ack(env, tok, { ack: true })).json()) as { disclaimer_ack_at: number }
    expect(body.disclaimer_ack_at).toBeGreaterThanOrEqual(CREATED)
    expect(state.updates).toHaveLength(1)
  })

  it("POST：body 非对象（数组 / 字符串 / null）或坏 JSON → 422；ack 非布尔 → 422", async () => {
    const { env, state } = disclaimerEnv(null)
    const tok = await token(env)
    for (const bad of [[], "x", null, "{"]) {
      const resp = await ack(env, tok, bad)
      expect(resp.status, JSON.stringify(bad)).toBe(422)
    }
    expect((await ack(env, tok, { ack: "yes" })).status).toBe(422)
    expect((await ack(env, tok, { ack: 1 })).status).toBe(422)
    expect(await (await ack(env, tok, { ack: "yes" })).json()).toEqual({ error: "invalid-ack" })
    expect(state.updates).toHaveLength(0) // 校验失败一律不写库
  })

  it("POST：缺 D1 → 503；账号行不存在（changes=0）→ 404（不让前端误以为记住了）", async () => {
    const noDb = { JWT_SECRET } as unknown as Env
    const tokNoDb = await issueSession(noDb, { sub: "acc-1", handle: "alice", role: "user" })
    expect((await ack(noDb, tokNoDb)).status).toBe(503)

    const { env } = disclaimerEnv(null, 0 /* 账号行已不存在 */)
    const resp = await ack(env, await token(env))
    expect(resp.status).toBe(404)
    expect(await resp.json()).toEqual({ error: "account-not-found" })
  })

  it("旧库（还没跑 apply-schema，没有 disclaimer_ack_at 列）→ /me 退化为旧查询仍 200，绝不 500", async () => {
    const state = { ackAt: null as number | null }
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("disclaimer_ack_at FROM accounts")) throw new Error("SQLITE_ERROR: no such column: disclaimer_ack_at")
                if (sql.includes("SELECT status, created_at FROM accounts")) {
                  return { status: "active", created_at: CREATED }
                }
                if (sql.includes("SELECT created_at FROM accounts")) return { created_at: CREATED }
                if (sql.includes("SELECT period_start")) {
                  return { period_start: CREATED + Math.floor((Date.now() - CREATED) / (5 * HOUR_MS)) * 5 * HOUR_MS, used_cost: 0, monthly_limit: 5 }
                }
                return null
              },
              async run() {
                // 旧库上写 disclaimer_ack_at 会失败 → POST 应回 503（前端只 warn，本地照常生效）
                if (sql.startsWith("UPDATE accounts SET disclaimer_ack_at")) throw new Error("SQLITE_ERROR: no such column: disclaimer_ack_at")
                return { success: true, results: [], meta: { changes: 0 } }
              },
            }
          },
        }
      },
    }
    const env = { DB: db as unknown as Env["DB"], JWT_SECRET } as unknown as Env
    const tok = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })

    const me = await getMe(env, tok)
    expect(me.status).toBe(200) // 关键：不是 500
    expect(me.body.disclaimer_ack).toBe(false)
    expect(me.body.disclaimer_ack_at).toBeNull()
    expect(state.ackAt).toBeNull()

    expect((await ack(env, tok)).status).toBe(503) // 写不进去 → 503（前端 console.warn，不影响本地记住）
  })

  it("旧库且退化查询也失败（真·DB 故障）→ 照旧向上抛（不伪装成 account-not-found）", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                throw new Error(`d1-down: ${sql.slice(0, 24)}`)
              },
              async run() {
                return { success: true, results: [], meta: { changes: 0 } }
              },
            }
          },
        }
      },
    }
    const env = { DB: db as unknown as Env["DB"], JWT_SECRET } as unknown as Env
    const tok = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
    const resp = await app.request("/api/v1/me", { headers: { Authorization: `Bearer ${tok}` } }, env)
    expect(resp.status).toBe(500) // onError 兜底，只回泛化 internal-error
    expect(await resp.json()).toEqual({ error: "internal-error" })
  })

  it("迁移：disclaimer_ack_at 的补列语句在 SCHEMA_MIGRATIONS 里，且老库/新库两种报错都被容忍", () => {
    const stmt = "ALTER TABLE accounts ADD COLUMN disclaimer_ack_at INTEGER"
    expect([...SCHEMA_MIGRATIONS]).toContain(stmt)
    // 幂等性：列已存在 / 表还没建（全新库先跑迁移）都视为成功
    expect(isToleratedSchemaError(stmt, "SQLITE_ERROR: duplicate column name: disclaimer_ack_at")).toBe(true)
    expect(isToleratedSchemaError(stmt, "SQLITE_ERROR: no such table: accounts")).toBe(true)
    // 新库的建表语句本身已带该列（所以 approve-schema 之后无需 ALTER 也正确）
    const create = SCHEMA_STATEMENTS.find((q) => q.includes("CREATE TABLE IF NOT EXISTS accounts"))!
    expect(create).toContain("disclaimer_ack_at INTEGER")
  })
})

// ── /api/v1/admin/ingest/trigger（T2.2 运维入口）──
describe("POST /api/v1/admin/ingest/trigger", () => {
  function adminEnv(): Env {
    const del = vi.fn(async () => ({}))
    const send = vi.fn(async () => undefined)
    return {
      DB: {
        prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: del })) })),
      } as unknown as Env["DB"],
      INGEST_QUEUE: { send } as unknown as Env["INGEST_QUEUE"],
      ADMIN_API_KEY: "admin-secret",
      SEARCH_CACHE: undefined as never,
      QDRANT_URL: undefined,
    } as unknown as Env
  }

  it("未配置 ADMIN_API_KEY → 503", async () => {
    const env = { ...adminEnv(), ADMIN_API_KEY: undefined as never } as Env
    const resp = await app.request(
      "/api/v1/admin/ingest/trigger?wiki_id=mtf-wiki",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      env,
    )
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: "admin-key-unconfigured" })
  })

  it("无 Authorization 或错误 key → 401", async () => {
    const env = adminEnv()
    let resp = await app.request("/api/v1/admin/ingest/trigger", { method: "POST" }, env)
    expect(resp.status).toBe(401)
    resp = await app.request(
      "/api/v1/admin/ingest/trigger",
      { method: "POST", headers: { Authorization: "Bearer wrong" } },
      env,
    )
    expect(resp.status).toBe(401)
  })

  it("合法 key + 触发全部 wiki → 对每个发 Queue 消息", async () => {
    const env = adminEnv()
    const resp = await app.request(
      "/api/v1/admin/ingest/trigger",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      env,
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { sent: string[] }
    expect(body.sent.length).toBe(4) // mtf / ftm / rle / mio
    expect((env.INGEST_QUEUE.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4)
  })

  it("reset=1 → 清 D1 两张表 + 投递", async () => {
    const env = adminEnv()
    const resp = await app.request(
      "/api/v1/admin/ingest/trigger?wiki_id=mtf-wiki&reset=1",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      env,
    )
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { reset: Record<string, string> }
    expect(body.reset["mtf-wiki"]).toBe("ok")
    // DB.prepare 被调用两次（ingest_runs 删除 + ingest_files 删除）
    const prep = (env.DB.prepare as ReturnType<typeof vi.fn>)
    expect(prep).toHaveBeenCalledTimes(2)
    expect((env.INGEST_QUEUE.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("非法 wiki_id → 422", async () => {
    const resp = await app.request(
      "/api/v1/admin/ingest/trigger?wiki_id=not-a-wiki",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      adminEnv(),
    )
    expect(resp.status).toBe(422)
  })
})

// ── /api/v1/admin/whoami（诊断：反代后的客户端 IP 信任链）──
describe("GET /api/v1/admin/whoami", () => {
  const SECRET = "proxy-secret-xyz"
  /** 线上实测：经 Pages 反代后 CF 给子请求注入的内部地址。 */
  const INTERNAL = "2a06:98c0:3600::103"

  function whoamiEnv(secret?: string): Env {
    return {
      DB: undefined as never,
      SEARCH_CACHE: undefined as never,
      INGEST_QUEUE: undefined as never,
      ADMIN_API_KEY: "admin-secret",
      PROXY_SHARED_SECRET: secret,
    } as unknown as Env
  }

  async function call(env: Env, headers: Record<string, string>) {
    const resp = await app.request(
      "/api/v1/admin/whoami",
      { headers: { Authorization: "Bearer admin-secret", ...headers } },
      env,
    )
    expect(resp.status).toBe(200)
    return (await resp.json()) as Record<string, unknown>
  }

  it("未配置密钥 → 退化直连逻辑，且**绝不回显**任何密钥", async () => {
    const body = await call(whoamiEnv(), {
      "cf-connecting-ip": INTERNAL,
      "x-prism-client-ip": "1.2.3.4",
      "x-prism-proxy": SECRET,
    })
    expect(body["proxy-secret-configured"]).toBe(false)
    expect(body["x-prism-proxy-present"]).toBe(true) // 头到了
    expect(body["x-prism-proxy-trusted"]).toBe(false) // 但没配密钥 → 不采信
    expect(body.resolved_ip).toBe(INTERNAL)
    expect(body.resolved_by).toBe("cf-connecting-ip")
    // 安全：整个响应体里不能出现密钥值
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  it("密钥匹配 → resolved_by=proxy-trusted，采信 x-prism-client-ip", async () => {
    const body = await call(whoamiEnv(SECRET), {
      "cf-connecting-ip": INTERNAL,
      "x-forwarded-for": "203.0.113.7",
      "x-prism-client-ip": "203.0.113.7",
      "x-prism-proxy": SECRET,
    })
    expect(body["proxy-secret-configured"]).toBe(true)
    expect(body["x-prism-proxy-present"]).toBe(true)
    expect(body["x-prism-proxy-trusted"]).toBe(true)
    expect(body["x-prism-client-ip"]).toBe("203.0.113.7")
    expect(body.resolved_ip).toBe("203.0.113.7")
    expect(body.resolved_by).toBe("proxy-trusted")
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  it("密钥不匹配（两边配了不同的值）→ present=true 但 trusted=false，退回 cf-connecting-ip", async () => {
    const body = await call(whoamiEnv(SECRET), {
      "cf-connecting-ip": INTERNAL,
      "x-prism-client-ip": "1.2.3.4",
      "x-prism-proxy": "another-secret",
    })
    expect(body["x-prism-proxy-present"]).toBe(true)
    expect(body["x-prism-proxy-trusted"]).toBe(false)
    expect(body.resolved_ip).toBe(INTERNAL)
    expect(body.resolved_by).toBe("cf-connecting-ip")
  })

  it("无任何来源头 → resolved_by=none；仍需 admin 鉴权", async () => {
    const body = await call(whoamiEnv(SECRET), {})
    expect(body.resolved_ip).toBe(null)
    expect(body.resolved_by).toBe("none")

    const denied = await app.request("/api/v1/admin/whoami", {}, whoamiEnv(SECRET))
    expect(denied.status).toBe(401)
  })
})