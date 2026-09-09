// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — X (Twitter) OAuth 2.0 登录 + 会话（tasks.md T3.1）
//
// 流程（OAuth 2.0 + PKCE，走 arctic）：
//   1. GET /api/v1/auth/oauth/x/start → 生成 state + code_verifier，存 KV（10 分钟），302 到 X 授权页
//   2. 用户在 X 授权 → 回调 GET /api/v1/auth/oauth/x/callback?code&state
//   3. 校验 state（KV 取回 code_verifier）→ 换 access token → 取 /2/users/me（id + username）
//   4. upsert accounts + bindings(type=x) + quotas → 签 JWT → 302 回前端 #token=<jwt>
//
// 隐私底线（plan.md §6.4）：只取 X 的 id + username 用于识别；**x_id 与 handle 均不落库明文**——
// DB 只存 `sha256(x_id)` 作为绑定标识（bindings.identifier），provider_id 恒为 NULL，
// handle 只存在于会话 JWT 中（每次登录从 X 重新取）。不存邮箱/手机/实名，不存 access token，不落日志明文。
//
// 会话：无状态 JWT（HS256，`jose`），前端存 localStorage 并走 `Authorization: Bearer`。
// 不用 Cookie：前端与 Worker 跨站（search.chengxi.moe → *.workers.dev），第三方 Cookie 会被浏览器拦。

import { Twitter, generateCodeVerifier, generateState } from "arctic"
import { SignJWT, jwtVerify } from "jose"
import type { Env } from "./types"

/** 会话 JWT 载荷。 */
export interface SessionPayload {
  /** account_id */
  sub: string
  /** X handle（展示用） */
  handle: string
  /** user | admin */
  role: "user" | "admin"
}

/** 登录后拿到的用户信息（对外返回，绝不含 x_id 之外的隐私）。 */
export interface AuthUser {
  account_id: string
  handle: string
  role: "user" | "admin"
}

/** KV 里暂存的 OAuth 中间态。 */
interface OAuthState {
  /** PKCE code_verifier */
  v: string
  /** 登录成功后回跳的前端地址（经白名单校验） */
  r: string
}

/** OAuth state 在 KV 的存活时间（秒）。 */
const STATE_TTL = 600
/** 会话有效期。 */
const SESSION_TTL = "30d"
/** 需要的 X scope：读用户信息 + 基础读权限（X 的 /users/me 需要 tweet.read 才稳）。 */
const X_SCOPES = ["users.read", "tweet.read"]

export class AuthConfigError extends Error {}

/** 构造 arctic Twitter provider；缺配置抛 AuthConfigError。 */
function provider(env: Env): Twitter {
  const id = env.X_CLIENT_ID
  const secret = env.X_CLIENT_SECRET
  const redirect = env.OAUTH_REDIRECT_URI
  if (!id || !secret || !redirect) {
    throw new AuthConfigError("x-oauth-unconfigured")
  }
  return new Twitter(id, secret, redirect)
}

/** 前端回跳基址：优先 env，其次 ALLOWED_ORIGINS 第一项，最后 localhost。 */
export function frontendBase(env: Env): string {
  if (env.FRONTEND_BASE_URL) return env.FRONTEND_BASE_URL.replace(/\/+$/, "")
  const first = (env.ALLOWED_ORIGINS ?? "").split(",")[0]?.trim()
  return (first || "http://localhost:3000").replace(/\/+$/, "")
}

/** 生成 state + PKCE verifier 并写入 KV，返回授权跳转 URL。 */
export async function startXLogin(
  env: Env,
  redirectAfter: string | undefined,
): Promise<{ url: string; state: string }> {
  const x = provider(env)
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = x.createAuthorizationURL(state, codeVerifier, X_SCOPES)

  const after = sanitizeRedirect(env, redirectAfter)
  const payload: OAuthState = { v: codeVerifier, r: after }
  if (env.SEARCH_CACHE) {
    await env.SEARCH_CACHE.put(`oauth:${state}`, JSON.stringify(payload), { expirationTtl: STATE_TTL })
  }
  return { url: url.toString(), state }
}

/** 回跳地址白名单校验：只允许与 ALLOWED_ORIGINS 同源，否则退回前端基址。 */
function sanitizeRedirect(env: Env, raw: string | undefined): string {
  const base = frontendBase(env)
  if (!raw) return `${base}/login`
  try {
    const u = new URL(raw)
    const allowed = (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const origin = `${u.protocol}//${u.host}`
    if (allowed.includes("*") || allowed.includes(origin) || origin === new URL(base).origin) {
      return raw
    }
  } catch {
    // 非法 URL：退回默认
  }
  return `${base}/login`
}

/** sha256 hex（identifier 落库最小化用）。 */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** X /2/users/me 返回（只取 id + username）。 */
interface XMe {
  data?: { id?: string; username?: string }
}

/** 用授权码换 token 并取用户 id/username。 */
export async function exchangeXCode(
  env: Env,
  code: string,
  state: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ xId: string; handle: string; redirectAfter: string }> {
  const x = provider(env)
  if (!env.SEARCH_CACHE) throw new AuthConfigError("kv-unconfigured")

  const raw = await env.SEARCH_CACHE.get(`oauth:${state}`)
  if (!raw) throw new Error("oauth-state-expired")
  await env.SEARCH_CACHE.delete(`oauth:${state}`)
  const saved = JSON.parse(raw) as OAuthState

  const tokens = await x.validateAuthorizationCode(code, saved.v)
  const resp = await fetchImpl("https://api.x.com/2/users/me?user.fields=username", {
    headers: { Authorization: `Bearer ${tokens.accessToken()}` },
  })
  if (!resp.ok) throw new Error(`x-users-me-failed status=${resp.status}`)
  const me = (await resp.json()) as XMe
  const xId = me.data?.id ?? ""
  const handle = me.data?.username ?? ""
  if (!xId) throw new Error("x-user-id-missing")
  return { xId, handle, redirectAfter: saved.r }
}

/** 该 X id 是否在管理员名单（ADMIN_X_IDS，逗号分隔数字 id）。 */
function isAdmin(env: Env, xId: string): boolean {
  return (env.ADMIN_X_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(xId)
}

/** 当前月起点（UTC，epoch ms）——配额周期。 */
export function monthStart(nowMs: number): number {
  const d = new Date(nowMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/**
 * 按 X id upsert 账号：已绑定则复用，未绑定则建 account + binding + quotas。
 * **隐私**：DB 里只落 `sha256(x_id)`（bindings.identifier），不存 x_id 明文、不存 handle 明文；
 * `provider_id` 恒为 NULL；展示名只活在会话 JWT 里（每次登录从 X 重新取）。
 * 返回 account_id / handle / role / status（handle 来自本次登录，非 DB）。
 */
export async function upsertXAccount(
  db: D1Database,
  env: Env,
  xId: string,
  handle: string,
  nowMs: number,
): Promise<{ account_id: string; handle: string; role: "user" | "admin"; status: string }> {
  const identifier = await sha256Hex(xId)
  const role: "user" | "admin" = isAdmin(env, xId) ? "admin" : "user"

  const existing = await db
    .prepare("SELECT account_id FROM bindings WHERE type = 'x' AND identifier = ?")
    .bind(identifier)
    .first<{ account_id: string }>()

  if (existing?.account_id) {
    const acc = await db
      .prepare("SELECT status FROM accounts WHERE id = ?")
      .bind(existing.account_id)
      .first<{ status: string }>()
    return { account_id: existing.account_id, handle, role, status: acc?.status ?? "active" }
  }

  const accountId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()
  await db.batch([
    // handle 故意写空串：X 展示名不落库（隐私底线，见文件头注释）
    db
      .prepare("INSERT INTO accounts (id, handle, created_at, status) VALUES (?, '', ?, 'active')")
      .bind(accountId, nowMs),
    // provider_id 恒为 NULL：不存 x_id 明文，只存 sha256 哈希
    db
      .prepare(
        "INSERT INTO bindings (id, account_id, type, identifier, provider_id, created_at, verified) VALUES (?, ?, 'x', ?, NULL, ?, 1)",
      )
      .bind(bindingId, accountId, identifier, nowMs),
    db
      .prepare(
        "INSERT INTO quotas (account_id, period_start, used_cost, monthly_limit, updated_at) VALUES (?, ?, 0, 5.0, ?)",
      )
      .bind(accountId, monthStart(nowMs), nowMs),
  ])
  return { account_id: accountId, handle, role, status: "active" }
}

/** 签发会话 JWT。 */
export async function issueSession(env: Env, payload: SessionPayload): Promise<string> {
  if (!env.JWT_SECRET) throw new AuthConfigError("jwt-secret-unconfigured")
  const key = new TextEncoder().encode(env.JWT_SECRET)
  return await new SignJWT({ handle: payload.handle, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(key)
}

/** 校验会话 JWT；无效/过期返回 null（绝不抛错，避免 500）。 */
export async function verifySession(env: Env, token: string): Promise<SessionPayload | null> {
  if (!env.JWT_SECRET || !token) return null
  try {
    const key = new TextEncoder().encode(env.JWT_SECRET)
    const { payload } = await jwtVerify(token, key)
    const sub = typeof payload.sub === "string" ? payload.sub : ""
    if (!sub) return null
    return {
      sub,
      handle: typeof payload.handle === "string" ? payload.handle : "",
      role: payload.role === "admin" ? "admin" : "user",
    }
  } catch {
    return null
  }
}

/** 从 Authorization: Bearer 头取会话；无/无效返回 null。 */
export async function sessionFromHeader(env: Env, header: string | undefined): Promise<SessionPayload | null> {
  const m = /^Bearer\s+(.+)$/i.exec((header ?? "").trim())
  if (!m) return null
  return await verifySession(env, m[1])
}

/** 拼登录成功后的前端回跳地址（token 放 fragment，不进服务端日志）。 */
export function loginRedirectUrl(env: Env, redirectAfter: string, token: string): string {
  const base = redirectAfter || `${frontendBase(env)}/login`
  const sep = base.includes("#") ? "&" : "#"
  return `${base}${sep}token=${encodeURIComponent(token)}`
}
