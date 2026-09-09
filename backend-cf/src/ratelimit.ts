// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 限流（tasks.md T3.3 / plan.md §6.1）
//
// ── 算法 ──
// **固定窗口计数**（KV）：窗口序号 = floor(nowMs / (windowSec*1000))，
// key = `rl:<scope>:<id>:<windowIndex>`，值 = JSON `{ c: 计数, t: 写入时刻 }`，TTL 取 2 个窗口
// （KV 的 expirationTtl 下限是 60s，故实际取 max(60, windowSec*2)）。
// 固定窗口足够挡「异常频率」，且实现简单、可单测（时间由 nowMs 注入，不依赖真实时钟）。
//
// ── 为什么不是精确限流 ──
// Cloudflare KV **没有原子自增**、且多边缘最终一致 → 并发下计数可能偏低。
// 因此本模块定位是**尽力而为的防刷闸门**，不是计费依据；精确计量走 quota.ts 的 D1 原子扣减。
//
// ── 降级（可用性优先）──
// KV 缺失 / 读写异常 / 参数非法 → **fail-open 放行**，并置 `degraded=true`，调用方据此打 warning。
//
// ── 隐私 ──
// IP 不落 KV 明文：`ipKey()` 用 FNV-1a 32 位散列（限流场景不需要可逆，碰撞只是共桶）。
// 账号 id 本身是 randomUUID，非 PII，直接入 key。
// KVNamespace 类型由 tsconfig 的 `types: ["@cloudflare/workers-types"]` 全局注入（与 auth.ts 一致）。

/** 限流存储的最小契约（KVNamespace 与测试内存 mock 都能满足）。 */
export interface RateLimitStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/** KVNamespace → RateLimitStore 适配（生产路径用；结构与 KVNamespace 对齐，便于 mock 注入）。 */
export function kvRateLimitStore(kv: KVNamespace): RateLimitStore {
  return {
    async get(key) {
      return kv.get(key)
    },
    async put(key, value, options) {
      await kv.put(key, value, options)
    },
  }
}

/** 单维度限流结果。 */
export interface RateLimitResult {
  /** 是否放行 */
  allowed: boolean
  /** 本窗口剩余可用次数（放行时已扣掉本次） */
  remaining: number
  /** 被拒时建议的重试等待秒数（未拒为 0） */
  retryAfterSec: number
  /** KV 缺失/异常 → 已 fail-open 放行，调用方应打 warning */
  degraded: boolean
  /** 本窗口计数（含本次；KV 不可用时为 0） */
  count: number
}

/** KV 里存的计数载荷。 */
interface CounterPayload {
  c: number
  t: number
}

/** FNV-1a 32 位散列（hex），用于 IP 匿名化。同步、无依赖、确定性。 */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // h *= 16777619，用移位避免超出 32 位精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** IP 维度 key（未登录主维度）：`rl:ip:<fnv1a>`，不含 IP 明文。 */
export function ipKey(ip: string): string {
  return `rl:ip:${fnv1aHex(ip.trim())}`
}

/** 账号维度 key（登录主维度）：`rl:acct:<accountId>`。 */
export function accountKey(accountId: string): string {
  return `rl:acct:${accountId}`
}

/** 窗口序号（导出便于单测/日志）。windowSec <= 0 时返回 -1。 */
export function windowIndexFor(nowMs: number, windowSec: number): number {
  if (!Number.isFinite(windowSec) || windowSec <= 0) return -1
  return Math.floor(nowMs / (windowSec * 1000))
}

/** 加上窗口序号得到 KV 里真正的 key（导出便于单测/排障）。 */
export function windowedKey(key: string, windowSec: number, nowMs: number): string {
  return `${key}:${windowIndexFor(nowMs, windowSec)}`
}

/** KV TTL：KV 下限 60s，取 2 个窗口防跨窗边界丢计数。 */
function ttlFor(windowSec: number): number {
  return Math.max(60, Math.ceil(windowSec * 2))
}

/**
 * 单维度固定窗口限流检查（并**计入本次**）。
 * @param store      KV 适配器；缺失 → fail-open
 * @param key        维度 key（ipKey / accountKey 或自定义）
 * @param limit      窗口内允许次数；<= 0 视为「禁止」（一律拒绝）
 * @param windowSec  窗口长度（秒）；非法 → fail-open
 * @param nowMs      当前时间（epoch ms；注入便于单测）
 */
export async function checkRateLimit(
  store: RateLimitStore | null | undefined,
  key: string,
  limit: number,
  windowSec: number,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  // 参数非法：无法计数 → 放行（fail-open），标记 degraded。
  if (!Number.isFinite(windowSec) || windowSec <= 0 || !Number.isFinite(nowMs)) {
    return { allowed: true, remaining: Number.isFinite(limit) ? Math.max(0, limit) : 0, retryAfterSec: 0, degraded: true, count: 0 }
  }
  const windowIndex = windowIndexFor(nowMs, windowSec)
  const windowEndMs = (windowIndex + 1) * windowSec * 1000
  const retryAfterSec = Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000))

  // limit <= 0：明确禁止（用于熔断/封禁兜底），不算 degraded。
  if (limit <= 0) {
    return { allowed: false, remaining: 0, retryAfterSec, degraded: false, count: 0 }
  }

  // KV 缺失：放行 + 标记（调用方打 warning）。
  if (!store) {
    return { allowed: true, remaining: limit, retryAfterSec: 0, degraded: true, count: 0 }
  }

  const fullKey = windowedKey(key, windowSec, nowMs)
  let count = 0
  let raw: string | null
  try {
    raw = await store.get(fullKey)
  } catch {
    // 读失败 → 放行（fail-open），但标记 degraded 供调用方打 warning。
    return { allowed: true, remaining: limit, retryAfterSec: 0, degraded: true, count: 0 }
  }
  if (raw) {
    // 值损坏/形状不对 → 当作 0 重新计数（不 fail-open，避免脏值把限流彻底关掉）。
    try {
      const parsed = JSON.parse(raw) as Partial<CounterPayload>
      if (typeof parsed?.c === "number" && Number.isFinite(parsed.c) && parsed.c > 0) count = Math.floor(parsed.c)
    } catch {
      count = 0
    }
  }

  if (count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSec, degraded: false, count }
  }

  const next = count + 1
  try {
    await store.put(fullKey, JSON.stringify({ c: next, t: nowMs } satisfies CounterPayload), {
      expirationTtl: ttlFor(windowSec),
    })
  } catch {
    // 写失败：本次仍放行（fail-open），但计数不可信 → degraded。
    return { allowed: true, remaining: Math.max(0, limit - next), retryAfterSec: 0, degraded: true, count: next }
  }
  return { allowed: true, remaining: Math.max(0, limit - next), retryAfterSec: 0, degraded: false, count: next }
}

/** 限流主体：未登录只有 ip；登录后有 accountId（ip 作兜底）。 */
export interface RateLimitSubject {
  /** 客户端 IP（CF-Connecting-IP） */
  ip?: string
  /** 登录账号 id（有则为主维度） */
  accountId?: string
}

/** 双维度策略（plan §6.1：未登录按 IP，登录按账号 + IP 兜底）。 */
export interface RateLimitPolicy {
  /** 账号维度限额 */
  account: { limit: number; windowSec: number }
  /** IP 兜底限额（通常比账号宽，防「单 IP 多号」） */
  ip: { limit: number; windowSec: number }
}

/** 默认策略（初值，M4 按真实流量调）：账号 30 次/分钟，IP 60 次/分钟。 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  account: { limit: 30, windowSec: 60 },
  ip: { limit: 60, windowSec: 60 },
}

/** 组合维度结果：scope 标记被拒/生效的维度。 */
export interface SubjectRateLimitResult extends RateLimitResult {
  /** 拒绝维度；放行时为实际生效维度（都无 key 时 "none"） */
  scope: "account" | "ip" | "none"
}

/**
 * 组合限流策略：
 *   - 有 accountId → 先查账号维度；被拒直接返回（scope="account"）；
 *   - 再查 IP 兜底（登录后仍生效，防单 IP 多号）；被拒返回（scope="ip"）；
 *   - 两者都过 → 放行，remaining 取两者较小值，degraded 取或；
 *   - 既无 ip 也无 accountId → 无法计数，放行 + degraded（调用方打 warning）。
 */
export async function checkSubjectRateLimit(
  store: RateLimitStore | null | undefined,
  subject: RateLimitSubject,
  policy: RateLimitPolicy = DEFAULT_RATE_LIMIT_POLICY,
  nowMs: number = Date.now(),
): Promise<SubjectRateLimitResult> {
  const accountId = subject.accountId?.trim()
  const ip = subject.ip?.trim()

  if (!accountId && !ip) {
    return { allowed: true, remaining: 0, retryAfterSec: 0, degraded: true, count: 0, scope: "none" }
  }

  let accountResult: RateLimitResult | null = null
  if (accountId) {
    accountResult = await checkRateLimit(store, accountKey(accountId), policy.account.limit, policy.account.windowSec, nowMs)
    if (!accountResult.allowed) return { ...accountResult, scope: "account" }
  }

  let ipResult: RateLimitResult | null = null
  if (ip) {
    ipResult = await checkRateLimit(store, ipKey(ip), policy.ip.limit, policy.ip.windowSec, nowMs)
    if (!ipResult.allowed) return { ...ipResult, scope: "ip" }
  }

  const active = accountResult ?? ipResult
  const remaining =
    accountResult && ipResult ? Math.min(accountResult.remaining, ipResult.remaining) : (active?.remaining ?? 0)
  return {
    allowed: true,
    remaining,
    retryAfterSec: 0,
    degraded: Boolean(accountResult?.degraded || ipResult?.degraded),
    count: active?.count ?? 0,
    scope: accountId ? "account" : "ip",
  }
}

/** 从请求头取客户端 IP（CF-Connecting-IP 优先，其次 X-Forwarded-For 首个）。缺失 → undefined。 */
export function clientIpFromHeaders(headers: Headers): string | undefined {
  const direct = headers.get("CF-Connecting-IP")
  if (direct?.trim()) return direct.trim()
  const fwd = headers.get("X-Forwarded-For")
  const first = fwd?.split(",")[0]?.trim()
  return first || undefined
}

/** 构造 429 响应头（Retry-After 秒 + 泛化提示），供路由直接拼响应。 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const h: Record<string, string> = { "Retry-After": String(result.retryAfterSec) }
  if (result.degraded) h["X-RateLimit-Degraded"] = "1"
  return h
}
