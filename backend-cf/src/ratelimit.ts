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
//
// ── ⚠️ 已知局限：修好客户端 IP ≠ 限流就准了（线上实测，别误判）──
// 经 Cloudflare Pages Function 反代（`frontend/functions/api/[[path]].ts`）访问时，
// **IP 限流实际上完全不生效**：线上实测「13 秒内连打 12 次搜索」全部 200、零 429，
// 而按 RATE_LIMIT_IP_PER_MIN 早就该被拒。
// 原因**不是** IP 取错（那是本文件 clientIpFromHeaders 的老问题，已修，见下），
// 而是 CF 内部子请求会**跨 colo**：本模块的计数落在 KV，而 KV 是**最终一致**的，
// 各 colo 各写各的桶 → 同一 IP 在 N 个 colo 各拿到一份额度，计数永远不收敛。
// 结论：KV 上的 IP 限流只能当「同一 colo 内的尽力而为闸门」，
// 真正的边缘限流要靠 CF 的 Rate Limiting 规则（待办，不在本模块职责内）。
// **不要**为了这个现象去改算法或换存储（换 D1 也绕不开跨 colo 请求分布）。

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
  /** 客户端 IP（应来自 `clientIpFromHeaders(headers, env)` 的信任链，不要直接读 cf-connecting-ip） */
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

// ─────────────────────────────────────────────────────────────────────────────
// 客户端 IP 的信任链（线上踩坑换来的，改动前务必读完）
// ─────────────────────────────────────────────────────────────────────────────
//
// ── 问题 ──
// 墙内用户走 `search.chengxi.moe/api/*`（Pages Function 反代）访问本 Worker，
// 这是「Worker → Worker 的子请求」。CF 在子请求上会**重新注入** `cf-connecting-ip` / `x-real-ip`，
// 值是 CF 内部地址（线上实测恒为 `2a06:98c0:3600::103`，且与真实客户端无关）——
// **而且这个头在 Pages Function 里删不掉**（实测 `headers.delete("cf-connecting-ip")` 之后后端照样收到）。
// 于是「优先读 cf-connecting-ip」的老逻辑会把**所有反代用户归进同一个限流桶**。
//
// ── 所以信任锚点改成「我们代理亲自签发的凭据」──
// 不能删头，就只能**信任一个只有我们代理知道的头**：
//   · `x-prism-proxy`     = 共享密钥（Pages Function 写入，值来自 Pages env / Worker secret）
//   · `x-prism-client-ip` = 真实客户端 IP（Pages Function 从**入站请求**的 cf-connecting-ip 摘下来的）
// 直连 `workers.dev` 的伪造者不知道密钥，写不出匹配的 `x-prism-proxy`，因此伪造无效。
//
// ── 判定顺序（严格按此顺序，不要重排）──
//   1) `env.PROXY_SHARED_SECRET` 非空 **且** `x-prism-proxy` 与之**完全相等**（恒时比较）
//      → 采信 `x-prism-client-ip`；该头缺失/为空则回落到 `x-forwarded-for` 首段（同为代理写入）。
//   2) 否则沿用**今天的老逻辑**：`cf-connecting-ip` → 其次 `x-forwarded-for` 首段。
//      `env` 缺失或密钥未配置时，行为与改造前**逐字节一致**（优雅降级，不抛错）。
//
// ── 为什么第 1 条不能无条件信任 XFF ──
// `workers.dev` 是公网可达的：直连者可以自带 `X-Forwarded-For: <随机 IP>` 轮换绕过限流。
// 只有当请求带着**我们代理的密钥**时，XFF 才是我们代理自己写的、可信的。
//
// ── 为什么用恒时比较 ──
// 普通 `===` 逐字节比较会在首个不同字节处提前返回，泄漏「前缀猜对了多少」的时序侧信道。
// 这里长度不同直接 false（长度本身不是秘密），等长则全量异或累加后一次判零。

/** 代理凭据头名（必须与 `frontend/functions/api/[[path]].ts` 中的写入端**逐字符一致**）。 */
export const PROXY_SECRET_HEADER = "x-prism-proxy"

/** 代理转发的真实客户端 IP 头名（同上，两端必须一致）。 */
export const PROXY_CLIENT_IP_HEADER = "x-prism-client-ip"

/** `clientIpFromHeaders` 用得到的 env 子集（避免与 types.ts 的 Env 循环依赖）。 */
export interface ClientIpEnv {
  /**
   * 与 Pages Function 共享的代理密钥。**Pages env 与 Worker secret 两处必须设成同一个值**；
   * 不设（或只有一边设）→ 退化为直连逻辑（第 1 条整条跳过），且经反代时 IP 会取到 CF 内部地址。
   */
  PROXY_SHARED_SECRET?: string
}

/** `resolved_by` 的取值：IP 是通过哪条路径采信到的。 */
export type ClientIpSource = "proxy-trusted" | "cf-connecting-ip" | "x-forwarded-for" | "none"

/** IP 判定结果（`resolved_by` 供 /admin/whoami 排障用）。 */
export interface ClientIpResolution {
  /** 采信到的客户端 IP；无法判定时为 undefined */
  ip?: string
  /** 判定依据 */
  by: ClientIpSource
}

/**
 * 恒时字符串比较（等价于「`a === b` 但不因首个不同字节提前返回」）。
 * 长度不同 → 直接 false（长度不是秘密，且能避免越界比较）。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** `x-forwarded-for` 的首段（最靠近客户端的那个地址）；空串/缺失 → undefined。 */
function firstForwardedFor(headers: Headers): string | undefined {
  return headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || undefined
}

/** 非空（trim 后）才返回值，否则 undefined——避免把空头当成有效 IP。 */
function nonEmpty(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined
}

/**
 * 判定客户端 IP 及其依据（信任链见本段顶部注释）。
 * @param headers 请求头
 * @param env     运行时 env；缺失/未配密钥 → 退化为老逻辑（不抛错）
 */
export function resolveClientIp(headers: Headers, env?: ClientIpEnv): ClientIpResolution {
  // ① 代理凭据：只有「配了密钥」且「头值与密钥完全相等」才成立（恒时比较）。
  const secret = typeof env?.PROXY_SHARED_SECRET === "string" ? env.PROXY_SHARED_SECRET : ""
  if (secret.length > 0) {
    const proof = headers.get(PROXY_SECRET_HEADER)
    if (proof !== null && timingSafeEqualString(proof, secret)) {
      // 采信代理写的真实 IP；该头缺失则回落代理写的 XFF 首段。
      // resolved_by 一律记 "proxy-trusted"（信任路径是同一条）：
      // 到底用的是哪个头，看 whoami 里原样回显的 x-prism-client-ip 是否为 null 即可区分。
      const claimed = nonEmpty(headers.get(PROXY_CLIENT_IP_HEADER)) ?? firstForwardedFor(headers)
      if (claimed) return { ip: claimed, by: "proxy-trusted" }
    }
  }

  // ② 老逻辑（向后兼容）：cf-connecting-ip 优先，其次 XFF 首段。
  // 注意：在「代理未配密钥」时这里拿到的 cf-connecting-ip 是 CF 的内部地址——这不是本函数能修的，
  // 只能在两端配上 PROXY_SHARED_SECRET（见上方说明）。
  const direct = nonEmpty(headers.get("CF-Connecting-IP"))
  if (direct) return { ip: direct, by: "cf-connecting-ip" }
  const fwd = firstForwardedFor(headers)
  if (fwd) return { ip: fwd, by: "x-forwarded-for" }
  return { by: "none" }
}

/**
 * 从请求头取客户端 IP（CF-Connecting-IP 优先，其次 X-Forwarded-For 首个）。缺失 → undefined。
 *
 * ⚠️ 反代场景请务必把 `env` 传进来：只在两端配了同一个 `PROXY_SHARED_SECRET` 时，
 * 本函数才会采信代理签发的真实 IP，否则会拿到 CF 给子请求注入的内部地址（见上方信任链注释）。
 */
export function clientIpFromHeaders(headers: Headers, env?: ClientIpEnv): string | undefined {
  return resolveClientIp(headers, env).ip
}

/** 构造 429 响应头（Retry-After 秒 + 泛化提示），供路由直接拼响应。 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const h: Record<string, string> = { "Retry-After": String(result.retryAfterSec) }
  if (result.degraded) h["X-RateLimit-Degraded"] = "1"
  return h
}
