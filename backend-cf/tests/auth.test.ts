// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 登录与会话单测（tasks.md T3.1）
// 全 mock：global fetch（X token/users.me）、KV（state 暂存）、D1。绝不触真实上游。
// 重点覆盖隐私底线：DB 落库参数里**不得出现明文 x_id / handle**（只允许 sha256 哈希）。
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  sha256Hex,
  monthStart,
  issueSession,
  verifySession,
  sessionFromHeader,
  startXLogin,
  exchangeXCode,
  upsertXAccount,
  loginRedirectUrl,
  frontendBase,
  AuthConfigError,
} from "../src/auth"
import { app } from "../src/index"
import type { Env } from "../src/types"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 内存 KV mock。 */
function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
  }
}

/** D1 mock：记录每次 bind 的 sql+args；first() 依次弹出预置结果。 */
function makeDb(firsts: unknown[] = []) {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const queue = [...firsts]
  const builder = (sql: string) => {
    const rec = { sql, args: [] as unknown[] }
    const stmt = {
      bind(...args: unknown[]) {
        rec.args = args
        calls.push(rec)
        return stmt
      },
      first: async () => (queue.length ? queue.shift() : null),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }
    return stmt
  }
  return {
    calls,
    db: {
      prepare: (sql: string) => builder(sql),
      batch: async (stmts: unknown[]) => stmts,
    } as unknown as D1Database,
  }
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: undefined as never,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    X_CLIENT_ID: "client-id",
    X_CLIENT_SECRET: "client-secret",
    OAUTH_REDIRECT_URI: "https://w.example/api/v1/auth/oauth/x/callback",
    FRONTEND_BASE_URL: "https://search.example",
    JWT_SECRET: "a".repeat(64),
    ALLOWED_ORIGINS: "https://search.example,http://localhost:3000",
    ...over,
  } as unknown as Env
}

describe("sha256Hex / monthStart", () => {
  it("sha256 稳定且为 64 位 hex", async () => {
    const h1 = await sha256Hex("12345")
    const h2 = await sha256Hex("12345")
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(h1).not.toContain("12345")
  })

  it("monthStart 取当月 UTC 月初", () => {
    const ms = monthStart(Date.UTC(2026, 8, 9, 12, 34)) // 2026-09-09
    expect(new Date(ms).toISOString()).toBe("2026-09-01T00:00:00.000Z")
  })
})

describe("会话 JWT", () => {
  it("签发→校验往返一致", async () => {
    const env = makeEnv()
    const token = await issueSession(env, { sub: "acc-1", handle: "alice", role: "user" })
    const s = await verifySession(env, token)
    expect(s).toEqual({ sub: "acc-1", handle: "alice", role: "user" })
  })

  it("篡改 / 换密钥 / 缺密钥 → null（不抛错）", async () => {
    const env = makeEnv()
    const token = await issueSession(env, { sub: "acc-1", handle: "a", role: "user" })
    expect(await verifySession(env, token + "x")).toBeNull()
    expect(await verifySession(makeEnv({ JWT_SECRET: "b".repeat(64) }), token)).toBeNull()
    expect(await verifySession(makeEnv({ JWT_SECRET: undefined }), token)).toBeNull()
    expect(await verifySession(env, "")).toBeNull()
  })

  it("sessionFromHeader 只认 Bearer", async () => {
    const env = makeEnv()
    const token = await issueSession(env, { sub: "acc-1", handle: "a", role: "admin" })
    expect((await sessionFromHeader(env, `Bearer ${token}`))?.role).toBe("admin")
    expect(await sessionFromHeader(env, token)).toBeNull()
    expect(await sessionFromHeader(env, undefined)).toBeNull()
  })
})

describe("startXLogin", () => {
  it("生成带 PKCE 的授权 URL，并把 verifier 存 KV", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv({ SEARCH_CACHE: kv })
    const { url, state } = await startXLogin(env, undefined)

    expect(url).toContain("oauth2/authorize")
    expect(url).toContain(`state=${state}`)
    expect(url).toContain("code_challenge=")
    expect(url).toContain("code_challenge_method=S256")
    expect(store.has(`oauth:${state}`)).toBe(true)
  })

  it("缺配置 → AuthConfigError", async () => {
    await expect(startXLogin(makeEnv({ X_CLIENT_ID: undefined }), undefined)).rejects.toBeInstanceOf(AuthConfigError)
  })

  it("回跳地址做白名单校验：非白名单退回默认 /login", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv({ SEARCH_CACHE: kv })
    const bad = await startXLogin(env, "https://evil.example/steal")
    expect(JSON.parse(store.get(`oauth:${bad.state}`)!).r).toBe("https://search.example/login/")

    const good = await startXLogin(env, "https://search.example/settings")
    expect(JSON.parse(store.get(`oauth:${good.state}`)!).r).toBe("https://search.example/settings")
  })
})

describe("exchangeXCode", () => {
  it("换 token 并取 id/username，state 用后即删", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv({ SEARCH_CACHE: kv })
    const { state } = await startXLogin(env, "https://search.example/login")

    const fetchImpl = vi.fn(async (input: unknown): Promise<Response> => {
      // arctic 内部用 Request 对象调用 fetch，这里统一取出 URL
      const u = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
      if (u.includes("/2/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", expires_in: 7200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (u.includes("/2/users/me")) {
        return new Response(JSON.stringify({ data: { id: "12345", username: "alice" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("nope", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchImpl)

    const out = await exchangeXCode(env, "the-code", state, fetchImpl as unknown as typeof fetch)
    expect(out.xId).toBe("12345")
    expect(out.handle).toBe("alice")
    expect(out.redirectAfter).toBe("https://search.example/login")
    expect(store.has(`oauth:${state}`)).toBe(false) // 一次性
  })

  it("state 过期/不存在 → 抛错（不静默）", async () => {
    const { kv } = makeKv()
    const env = makeEnv({ SEARCH_CACHE: kv })
    await expect(exchangeXCode(env, "c", "nope", vi.fn() as unknown as typeof fetch)).rejects.toThrow(/oauth-state-expired/)
  })
})

describe("upsertXAccount（隐私底线）", () => {
  it("新用户：只落 sha256(x_id)，不落 x_id / handle 明文，provider_id 为 NULL", async () => {
    const { db, calls } = makeDb([null]) // 首次 SELECT bindings → 无记录
    const env = makeEnv()
    const res = await upsertXAccount(db, env, "12345", "alice", Date.now())

    expect(res.role).toBe("user")
    expect(res.handle).toBe("alice") // 返回值带 handle（给会话用），但库里不存

    const flat = calls.flatMap((c) => c.args.map((a) => String(a)))
    expect(flat).not.toContain("12345") // x_id 明文不得出现
    expect(flat).not.toContain("alice") // handle 明文不得出现

    const binding = calls.find((c) => c.sql.includes("INSERT INTO bindings"))
    expect(binding).toBeTruthy()
    const identifier = String(binding!.args[2])
    expect(identifier).toMatch(/^[0-9a-f]{64}$/)
    expect(identifier).toBe(await sha256Hex("12345"))
    expect(binding!.sql).toContain("NULL") // provider_id 恒 NULL

    const account = calls.find((c) => c.sql.includes("INSERT INTO accounts"))
    expect(account!.sql).toContain("''") // handle 写空串
  })

  it("老用户：复用同一 account_id，不再插入", async () => {
    const { db, calls } = makeDb([{ account_id: "acc-1" }, { status: "active" }])
    const res = await upsertXAccount(db, makeEnv(), "12345", "alice2", Date.now())
    expect(res.account_id).toBe("acc-1")
    expect(calls.some((c) => c.sql.includes("INSERT INTO accounts"))).toBe(false)
  })

  it("ADMIN_X_IDS 命中 → role=admin", async () => {
    const { db } = makeDb([{ account_id: "acc-1" }, { status: "active" }])
    const res = await upsertXAccount(db, makeEnv({ ADMIN_X_IDS: "999,12345" }), "12345", "alice", Date.now())
    expect(res.role).toBe("admin")
  })

  it("被封禁账号：返回 status=banned（由路由决定拒绝）", async () => {
    const { db } = makeDb([{ account_id: "acc-1" }, { status: "banned" }])
    const res = await upsertXAccount(db, makeEnv(), "12345", "alice", Date.now())
    expect(res.status).toBe("banned")
  })
})

describe("loginRedirectUrl / frontendBase", () => {
  it("token 放 fragment（不进服务端日志）", () => {
    const env = makeEnv()
    expect(loginRedirectUrl(env, "https://search.example/login", "tok")).toBe("https://search.example/login#token=tok")
  })

  it("frontendBase 优先 env，其次 ALLOWED_ORIGINS 首项", () => {
    expect(frontendBase(makeEnv())).toBe("https://search.example")
    expect(frontendBase(makeEnv({ FRONTEND_BASE_URL: undefined }))).toBe("https://search.example")
    expect(frontendBase(makeEnv({ FRONTEND_BASE_URL: undefined, ALLOWED_ORIGINS: undefined }))).toBe("http://localhost:3000")
  })
})

describe("路由接线", () => {
  it("GET /api/v1/me 无 token → 401", async () => {
    const resp = await app.request("/api/v1/me", {}, makeEnv())
    expect(resp.status).toBe(401)
  })

  it("GET /api/v1/auth/oauth/x/start 未配置 → 503", async () => {
    const resp = await app.request("/api/v1/auth/oauth/x/start", {}, makeEnv({ X_CLIENT_ID: undefined }))
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ error: "x-oauth-unconfigured" })
  })

  it("GET /api/v1/auth/oauth/x/callback 缺参 → 302 回前端带 error", async () => {
    const resp = await app.request("/api/v1/auth/oauth/x/callback", {}, makeEnv())
    expect(resp.status).toBe(302)
    expect(resp.headers.get("location")).toContain("/login#error=")
  })
})
