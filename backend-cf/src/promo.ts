// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 开业酬宾（限时 DeepSeek V4.1 Flash）状态与钱袋子
//
// 规格：plan-promo.md（§1.5 已定决策 / §5.1 密钥池 / §5.6 记账与用完即止）
//
// ── 这个模块只做四件事（纯逻辑 + 一次 KV 读，方便单测）──
//   ① 促销**状态**：KV flag `promo:ds` + env 默认值 → `PromoState`（带进程内缓存，与 key 禁用集同一套做法）；
//   ② **成本自算**（主口径）：`cost = miss/1e6×2 + cached/1e6×0.04 + completion/1e6×8`（单价见 §1.5 A1）；
//      ⚠️ 上游响应里的 `cost_cny` 只有结算后才有值（未结算时是 0 + `billing_pending=true`）→ 只能用来对账；
//   ③ **预算闸**：累计花销 ≥ 预算 → 促销自动关闭（`enabled:false`，reason=`budget-exhausted`）；
//      累计值走 **KV 计数 + 调用方 waitUntil 自增**（近似、不阻塞热路径），D1 的真值由
//      `/admin/usage/summary` 对账回写（见 `reconcileSpentCny()`）；
//   ④ 上游 401/402/403（key 坏/余额尽）→ 调用方调 `closePromo()` 立刻落 KV 关闭（**不需重新部署**）。
//
// ── 密钥规矩 ──
// 促销密钥来自 `DS_POOL_KEY_<n>`（独立池，**绝不与 `POOL_KEYS_<n>` 混**，见 plan §5.1）。
// 本模块**从不**读取/返回/记录 secret 本身；日志与响应里只有 ref（`ds-pool-key-<n>`）。

import { PROMO_KEY_VAR_PREFIX, parseMergedKeys, type PoolKey } from "./keypool"

// ─────────────────────────────────────────────
// 常量（可调项集中在此，单测直接断言）
// ─────────────────────────────────────────────

/** 促销上游端点（OpenAI 兼容；实测可用，§3）。 */
export const PROMO_ENDPOINT_DEFAULT = "https://tokenrhythm.studio/v1"
/** 促销模型 id（实测可用）。 */
export const PROMO_MODEL_DEFAULT = "deepseek-flash"
/** KV：促销状态（单个键，紧急关闭不必重新部署）。 */
export const PROMO_KV_KEY = "promo:ds"
/** KV：促销密钥的禁用集（admin 下架某把 DS key；与合并池的 `keydeny:keys` 互不影响）。 */
export const PROMO_DENY_KV_KEY = "keydeny:ds"
/** 两个 ¥68 key = 预算默认 ¥136（§1.5 A1）。 */
export const PROMO_BUDGET_CNY_DEFAULT = 136
/** 促销期 5h 配额窗口（4×：默认 300k → 1M，§5.4）。 */
export const PROMO_QUOTA_WINDOW_TOKENS_DEFAULT = 1_000_000
/** 促销单次输出上限（§1.5 A7：免费链 1000，促销 4000）。 */
export const PROMO_MAX_TOKENS_DEFAULT = 4_000
/** 期限默认天数（`PROMO_END_AT` 未配时，从"首次被读到"起算 30 天，§1.5 A5）。 */
export const PROMO_DAYS_DEFAULT = 30
/** 促销状态进程内缓存 TTL（秒）。与 key 禁用集同量级：紧急关闭最多滞后这么久生效。 */
export const PROMO_CACHE_TTL_SEC = 30

/** 单价（¥/M tokens，§1.5 A1）。 */
export const PROMO_PRICE_CNY_PER_M = {
  inputMiss: 2,
  inputCached: 0.04,
  output: 8,
} as const

// ─────────────────────────────────────────────
// 成本（纯函数）
// ─────────────────────────────────────────────

/** 一次促销调用的 usage（全部来自上游真实计数，§3 实测：流式末块带完整 usage）。 */
export interface PromoUsage {
  promptTokens: number
  /** 命中缓存的输入 token（`prompt_tokens_details.cached_tokens`）；缺省按 0 = 全 miss 计（宁可高估） */
  cachedTokens?: number
  completionTokens: number
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 自算成本（**主口径**）。
 * `miss = prompt − cached`；思考 token 计入 `completion_tokens`（上游如此返回），故输出价已覆盖。
 * 缓存命中的 token 若拿不到（老网关/字段缺失）→ 按 miss 价计（**宁可高估**，提前收闸更安全）。
 */
export function promoCostCny(u: PromoUsage): number {
  const prompt = num(u.promptTokens)
  const completion = num(u.completionTokens)
  const cached = Math.min(num(u.cachedTokens), prompt)
  const miss = Math.max(0, prompt - cached)
  const p = PROMO_PRICE_CNY_PER_M
  return (miss / 1e6) * p.inputMiss + (cached / 1e6) * p.inputCached + (completion / 1e6) * p.output
}

/** 金额格式（对账/展示用；保留 6 位小数，¥ 0.000001 级别也能看见）。 */
export function formatCny(v: number): string {
  if (!Number.isFinite(v)) return "0.000000"
  return v.toFixed(6)
}

/**
 * 按近 24h 花销速度估算"还能撑几天"（§5.6 烧钱速度告警用）。
 * 返回 null = 速度不足/数据不足（无法预计）。保守取整到 0.1 天。
 */
export function promoDaysLeft(spentCny: number, budgetCny: number, spent24hCny: number): number | null {
  // 入参不可信 → 明确"无法预计"（null），不要谎报 0 天（那会让告警误判成"已耗尽"）
  if (!Number.isFinite(spentCny) || !Number.isFinite(budgetCny) || !Number.isFinite(spent24hCny)) return null
  const remaining = budgetCny - spentCny
  if (remaining <= 0) return 0
  if (spent24hCny <= 0) return null // 近 24h 没花钱 → 速度未知
  return Math.round((remaining / spent24hCny) * 10) / 10
}

// ─────────────────────────────────────────────
// 状态（env 默认 + KV 覆盖 + 进程内缓存）
// ─────────────────────────────────────────────

/** 促销关闭的原因（会体现在 `/me` 与 `/admin/usage/summary`，便于排查）。 */
export type PromoReason = "enabled" | "disabled-by-env" | "no-keys" | "expired" | "budget-exhausted" | "disabled-by-flag"

export interface PromoState {
  enabled: boolean
  reason: PromoReason
  model: string
  endpoint: string
  /** 结束时间戳（ms）；null = 未设期限（`PROMO_END_AT` 未配且 KV 里还没有 started_at） */
  endsAt: number | null
  budgetCny: number
  spentCny: number
  remainingCny: number
  /** 促销期 5h 配额窗口（¥1M 口径，§5.4） */
  quotaWindowTokens: number
  /** 促销单次 max_tokens（§1.5 A7） */
  maxTokens: number
  /** 是否配了至少一把 `DS_POOL_KEY_<n>`（**不含**任何 secret，只判数量） */
  keyCount: number
  /** 状态来自 KV 还是仅 env（KV 不可用 → degraded；此时按 env 判定，fail-open 到"能用就用"） */
  degraded: boolean
}

/** KV 最小接口（与 keyadmin 的 DenyKvStore 同形，便于单测注入）。 */
export interface PromoKvStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

/** KVNamespace → 最小接口（缺失 → undefined：按 env 判定、degraded=true）。 */
export function kvPromoStore(kv: KVNamespace | null | undefined): PromoKvStore | undefined {
  if (!kv) return undefined
  return {
    get: (key: string) => kv.get(key),
    put: async (key: string, value: string) => {
      await kv.put(key, value)
    },
  }
}

function envString(env: unknown, key: string): string | undefined {
  if (typeof env !== "object" || env === null) return undefined
  const v = (env as Record<string, unknown>)[key]
  return typeof v === "string" ? v : undefined
}

function envNumber(env: unknown, key: string, fallback: number): number {
  const raw = envString(env, key)
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envBool(env: unknown, key: string, fallback: boolean): boolean {
  const raw = envString(env, key)?.trim().toLowerCase()
  if (raw === undefined || raw === "") return fallback
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false
  if (raw === "true" || raw === "1" || raw === "on" || raw === "yes") return true
  return fallback
}

/** KV 里 `promo:ds` 的形状（缺字段一律回落 env/默认）。 */
interface PromoFlag {
  enabled?: boolean
  ends_at?: number
  budget_cny?: number
  spent_cny?: number
  model?: string
  endpoint?: string
  started_at?: number
  note?: string
}

/** 解析 KV 值（脏值 → null = 当作没配，用 env 判定）。 */
export function parsePromoFlag(raw: string | null | undefined): PromoFlag | null {
  if (typeof raw !== "string" || raw.trim() === "") return null
  try {
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
    return obj as PromoFlag
  } catch {
    return null
  }
}

/** 促销密钥（**只出 PoolKey，secret 绝不离开本模块的调用方**）。 */
export function promoKeys(env: unknown): PoolKey[] {
  return parseMergedKeys(env, () => undefined, { varPrefix: PROMO_KEY_VAR_PREFIX, refPrefix: "ds-pool" })
}

/** 传给 KeyPool 的密钥变量选项（促销池）。 */
export function promoKeyVarOptions(): { varPrefix: string; refPrefix: string } {
  return { varPrefix: PROMO_KEY_VAR_PREFIX, refPrefix: "ds-pool" }
}

/**
 * 由 env + KV flag 计算促销状态（纯函数，便于单测）。
 * 判定顺序（任一不满足即关闭，reason 如实反映第一条不满足的原因）：
 *   ① env `PROMO_ENABLED=false` → disabled-by-env
 *   ② 没配任何 `DS_POOL_KEY_<n>` → no-keys（没有 key 就谈不上促销）
 *   ③ KV flag `enabled:false` → disabled-by-flag（管理员/预算闸写入）
 *   ④ 已过 `ends_at` → expired
 *   ⑤ 累计花销 ≥ 预算 → budget-exhausted
 */
export function resolvePromoState(args: {
  env: unknown
  flag: PromoFlag | null
  nowMs: number
  keyCount: number
  degraded?: boolean
}): PromoState {
  const { env, flag, nowMs, keyCount } = args
  const envEnabled = envBool(env, "PROMO_ENABLED", true)
  const budgetCny = flag?.budget_cny ?? envNumber(env, "PROMO_BUDGET_CNY", PROMO_BUDGET_CNY_DEFAULT)
  const spentCny = Math.max(0, num(flag?.spent_cny))
  const quotaWindowTokens = Math.floor(
    envNumber(env, "PROMO_QUOTA_WINDOW_TOKENS", PROMO_QUOTA_WINDOW_TOKENS_DEFAULT),
  )
  const maxTokens = Math.floor(envNumber(env, "PROMO_LLM_MAX_TOKENS", PROMO_MAX_TOKENS_DEFAULT))
  const envEndAt = envNumber(env, "PROMO_END_AT", 0)
  const days = envNumber(env, "PROMO_DAYS", PROMO_DAYS_DEFAULT)
  // 期限：env 明确给了就按 env；否则"首次被读到"的 started_at（KV 写入）+ N 天；都没有 → 不设期限
  const startedAt = num(flag?.started_at)
  const endsAt =
    envEndAt > 0 ? envEndAt : num(flag?.ends_at) > 0 ? num(flag?.ends_at) : startedAt > 0 ? startedAt + days * 86_400_000 : null
  const model = (flag?.model ?? envString(env, "DS_MODEL") ?? PROMO_MODEL_DEFAULT).trim() || PROMO_MODEL_DEFAULT
  const endpoint = (flag?.endpoint ?? envString(env, "DS_ENDPOINT") ?? PROMO_ENDPOINT_DEFAULT).trim().replace(/\/+$/, "")

  let enabled = true
  let reason: PromoReason = "enabled"
  if (!envEnabled) {
    enabled = false
    reason = "disabled-by-env"
  } else if (keyCount <= 0) {
    enabled = false
    reason = "no-keys"
  } else if (flag?.enabled === false) {
    enabled = false
    reason = "disabled-by-flag"
  } else if (endsAt !== null && nowMs >= endsAt) {
    enabled = false
    reason = "expired"
  } else if (spentCny >= promoBudgetGuardCny(budgetCny)) {
    // 留 5% 余量再收闸（§10.3：宁可早关，不要让上游真的欠费）
    enabled = false
    reason = "budget-exhausted"
  }

  return {
    enabled,
    reason,
    model,
    endpoint,
    endsAt,
    budgetCny,
    spentCny,
    remainingCny: Math.max(0, budgetCny - spentCny),
    quotaWindowTokens,
    maxTokens,
    keyCount,
    degraded: args.degraded === true,
  }
}

/** isolate 级缓存（每个 isolate 各存一份；与 keyadmin 的 denyCache 同一套做法）。 */
let promoCache: { state: PromoState; at: number } | null = null

/** 清空促销状态缓存（单测用；也便于运维在调试时手动失效）。 */
export function resetPromoCache(): void {
  promoCache = null
}

/** 进程内缓存里的最近一次状态（无则 null；供不需要精确值的调用方用）。 */
export function cachedPromoState(): PromoState | null {
  return promoCache?.state ?? null
}

/**
 * 读促销状态（**绝不抛错**：KV 缺失/读失败/脏值 → 按 env 判定 + degraded）。
 *
 * 性能：与 key 禁用集同样做进程内缓存（默认 30s），因此热路径上的额外 KV 读≈0。
 * 权衡：管理员把 KV flag 关掉后，**当前 isolate 最多 30 秒后生效**（多 isolate 最坏 30s）；
 * 这是刻意接受的 —— 促销是"钱的开关"，不是安全边界（同样的取舍见 keyadmin.readDeniedPoolsCached）。
 */
export async function readPromoState(
  kv: PromoKvStore | undefined,
  env: unknown,
  nowMs: number = Date.now(),
  opts: { ttlSec?: number; keyCount?: number } = {},
): Promise<PromoState> {
  const ttlSec = opts.ttlSec ?? PROMO_CACHE_TTL_SEC
  if (ttlSec > 0 && promoCache && nowMs - promoCache.at < ttlSec * 1000) return promoCache.state

  const keyCount = opts.keyCount ?? promoKeys(env).length
  let flag: PromoFlag | null = null
  let degraded = false
  if (!kv) {
    degraded = true
  } else {
    try {
      // 一次读两个键（状态 + DS 禁用集）：两者都在 KV、都极少变，合并读取省一次往返。
      const [rawFlag, rawDeny] = await Promise.all([kv.get(PROMO_KV_KEY), kv.get(PROMO_DENY_KV_KEY)])
      flag = parsePromoFlag(rawFlag)
      const denyRefs = (rawDeny ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      promoDenyRefs = denyRefs
      // 首次读到（还没 started_at）→ 立刻补写，让"部署时 + 30 天"这个默认期限有起点（不阻塞返回）
      if (flag === null || num(flag.started_at) === 0) {
        const seeded: PromoFlag = { ...(flag ?? {}), started_at: nowMs }
        void kv.put(PROMO_KV_KEY, JSON.stringify(seeded)).catch(() => undefined)
        flag = seeded
      }
    } catch {
      degraded = true
      flag = null
    }
  }
  const state = resolvePromoState({ env, flag, nowMs, keyCount, degraded })
  if (ttlSec > 0) promoCache = { state, at: nowMs }
  return state
}

// ─────────────────────────────────────────────
// DS 池的禁用集（admin 下架某把促销 key）
// ─────────────────────────────────────────────

/** 最近一次读到的 DS 禁用集（与 promoState 同一次 KV 往返读出来的）。 */
let promoDenyRefs: string[] = []

/** 促销池被禁用的 ref（供 KeyPool.setDenied("ds", ...)）。 */
export function promoDeniedRefs(): string[] {
  return promoDenyRefs
}

/** 写禁用集（fail-open：KV 不可用 → 返回 false，调用方照常放行）。 */
export async function setPromoKeyDenied(
  kv: PromoKvStore | undefined,
  keyRef: string,
  enabled: boolean,
): Promise<{ ok: boolean; refs: string[] }> {
  if (!kv) return { ok: false, refs: [] }
  try {
    const current = (await kv.get(PROMO_DENY_KV_KEY)) ?? ""
    const refs = new Set(
      current
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    if (enabled) refs.delete(keyRef)
    else refs.add(keyRef)
    const next = [...refs].sort()
    await kv.put(PROMO_DENY_KV_KEY, next.join(","))
    promoDenyRefs = next
    return { ok: true, refs: next }
  } catch {
    return { ok: false, refs: [] }
  }
}

// ─────────────────────────────────────────────
// 预算累计（KV 计数，近似；D1 为真值）
// ─────────────────────────────────────────────

/**
 * 累加已花金额（**近似**：读-改-写，高并发下可能少算几次）。
 * 调用方必须 `waitUntil`（不阻塞响应）；失败静默 —— 预算是护栏，不是计费系统：
 * 真值由 `/admin/usage/summary` 从 D1 对账回写（`reconcileSpentCny`，只往上修正）。
 *
 * 安全余量：`promoBudgetGuardCny()` 在判定时把预算**下调 5%**（宁早不晚，§10.3），
 * 而不是把累计值上浮 —— 这样"已花多少"对外始终是真实数字。
 */
export const PROMO_BUDGET_GUARD_RATIO = 0.95

/** 判定用的预算（比预算低 5%：给自己留出对账/延迟的余量）。 */
export function promoBudgetGuardCny(budgetCny: number): number {
  if (!Number.isFinite(budgetCny) || budgetCny <= 0) return 0
  return budgetCny * PROMO_BUDGET_GUARD_RATIO
}

export async function addPromoSpendCny(
  kv: PromoKvStore | undefined,
  deltaCny: number,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; spentCny: number }> {
  if (!kv || !Number.isFinite(deltaCny) || deltaCny <= 0) return { ok: false, spentCny: 0 }
  try {
    const flag = parsePromoFlag(await kv.get(PROMO_KV_KEY)) ?? {}
    const next = Math.max(0, num(flag.spent_cny)) + deltaCny
    const merged: PromoFlag = { ...flag, spent_cny: next, updated_at: nowMs } as PromoFlag
    await kv.put(PROMO_KV_KEY, JSON.stringify(merged))
    if (promoCache) promoCache = null // 让下一次读拿到新累计值（避免 30s 内看不到已花钱）
    return { ok: true, spentCny: next }
  } catch {
    return { ok: false, spentCny: 0 }
  }
}

/** 关闭促销（上游 401/余额不足、管理员手动、预算耗尽收尾都走这里）。 */
export async function closePromo(
  kv: PromoKvStore | undefined,
  note: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!kv) return false
  try {
    const flag = parsePromoFlag(await kv.get(PROMO_KV_KEY)) ?? {}
    const merged: PromoFlag = { ...flag, enabled: false, note: note.slice(0, 120), updated_at: nowMs } as PromoFlag
    await kv.put(PROMO_KV_KEY, JSON.stringify(merged))
    if (promoCache) promoCache = null
    return true
  } catch {
    return false
  }
}

/**
 * 用 D1 的真值对账 KV 计数（`/admin/usage/summary` 调用；**热路径绝不调用**）。
 * KV 少算时回写到真值（K 多算时不回退 —— 宁早不晚，避免来回抖动）。
 */
export async function reconcileSpentCny(
  kv: PromoKvStore | undefined,
  spentFromDbCny: number,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; spentCny: number; wrote: boolean }> {
  if (!kv || !Number.isFinite(spentFromDbCny)) return { ok: false, spentCny: 0, wrote: false }
  try {
    const flag = parsePromoFlag(await kv.get(PROMO_KV_KEY)) ?? {}
    const kvSpent = num(flag.spent_cny)
    // 双向收敛（2026-09-13 修）：D1 的 usage.cost 汇总才是**唯一真值**，KV 只是热路径近似。
    // 原先"只往上修正"，导致 KV 一旦多算（实测出现 ~2× 高估）就永远降不下来 →
    // 促销会在真实花费约一半时被提前砍掉。现在两边都对齐，差异 < 0.0001 元才跳过（避免无谓写 KV）。
    if (Math.abs(spentFromDbCny - kvSpent) < 0.0001) return { ok: true, spentCny: kvSpent, wrote: false }
    const merged: PromoFlag = { ...flag, spent_cny: spentFromDbCny, reconciled_at: nowMs } as PromoFlag
    await kv.put(PROMO_KV_KEY, JSON.stringify(merged))
    if (promoCache) promoCache = null
    return { ok: true, spentCny: spentFromDbCny, wrote: true }
  } catch {
    return { ok: false, spentCny: 0, wrote: false }
  }
}
