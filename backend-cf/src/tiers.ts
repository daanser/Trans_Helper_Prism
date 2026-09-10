// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 分档判定与限额（plan-ratelimit.md §4）
//
// 本模块是**纯函数**：不读 env（除显式传入的 `env` 参数）、不做 IO、不碰 D1/KV/网络。
// 目的只有一个：把「这次请求是谁」映射成一个档位，再映射成一个每分钟限额，便于单测穷举。
//
// ── 分档顺序（plan §4，**不要重排**）──
//   1. `logged_in`      有效 JWT 会话（另有 5h 加权 token 配额做精确计量）
//   2. `cn_residential` country=CN 且 ASN ∈ 家宽/移动白名单
//   3. `cn_idc`         country=CN 且 ASN ∈ 云/IDC 名单
//   4. `cn_other`       country=CN 且两个名单都不在（保守中间档）
//   5. `overseas`       country≠CN
//   6. `unknown`        取不到 country 或 ASN（最保守；故障时宁可少放行）
//
// ⚠️ 「缺 country **或** 缺 ASN → unknown」是**有意**的（plan §4 表格）：
// 经反代时若代理没把元数据转发全，我们会退到 5/min 而不是乐观地放到 15/min —— 见 §3 信任链。
//
// ── 默认限额（次/分钟，env 全部可覆盖，名字照 plan §4）──
//   RATE_LIMIT_LOGGED_IN_PER_MIN=60 / RATE_LIMIT_CN_RESIDENTIAL_PER_MIN=30 /
//   RATE_LIMIT_CN_OTHER_PER_MIN=15 / RATE_LIMIT_CN_IDC_PER_MIN=6 /
//   RATE_LIMIT_OVERSEAS_PER_MIN=10 / RATE_LIMIT_UNKNOWN_PER_MIN=5 /
//   RATE_LIMIT_LLM_DIVISOR=5（LLM 限额 = ceil(搜索限额 / 除数)，下限 1）
//   熔断：BURST_PER_10S=20 / ANON_GLOBAL_PER_MIN=600 / ANON_GLOBAL_HARD_PER_MIN=1200
import { CN_IDC_ASN, CN_RESIDENTIAL_ASN, OVERSEAS_HOSTING_ASN } from "./data/cn-asn"

/** 调用者档位（plan §4）。 */
export type Tier = "logged_in" | "cn_residential" | "cn_other" | "cn_idc" | "overseas" | "unknown"

/** 全部档位（便于遍历/统计；顺序与判定顺序一致）。 */
export const TIERS: readonly Tier[] = ["logged_in", "cn_residential", "cn_idc", "cn_other", "overseas", "unknown"]

/** 各档默认限额（次/分钟）。 */
export const TIER_DEFAULT_LIMITS: Readonly<Record<Tier, number>> = {
  logged_in: 60,
  cn_residential: 30,
  cn_other: 15,
  cn_idc: 6,
  overseas: 10,
  unknown: 5,
}

/** 各档限额的 env 变量名（与 plan §4 / types.ts 的 Env 字段**逐字符一致**）。 */
export const TIER_LIMIT_ENV: Readonly<Record<Tier, string>> = {
  logged_in: "RATE_LIMIT_LOGGED_IN_PER_MIN",
  cn_residential: "RATE_LIMIT_CN_RESIDENTIAL_PER_MIN",
  cn_other: "RATE_LIMIT_CN_OTHER_PER_MIN",
  cn_idc: "RATE_LIMIT_CN_IDC_PER_MIN",
  overseas: "RATE_LIMIT_OVERSEAS_PER_MIN",
  unknown: "RATE_LIMIT_UNKNOWN_PER_MIN",
}

/** LLM 限额除数默认值（plan §4.0：可改 4）。 */
export const DEFAULT_LLM_DIVISOR = 5

/** 单 IP 突发阈值（10 秒窗口内允许的请求数，plan §6）。 */
export const DEFAULT_BURST_PER_10S = 20
/** 全局匿名软熔断阈值（次/分钟）：超过 → 匿名只走关键词回退。 */
export const DEFAULT_ANON_GLOBAL_PER_MIN = 600
/** 全局匿名硬熔断阈值（次/分钟）：超过 → 匿名一律 429（登录用户不受影响）。 */
export const DEFAULT_ANON_GLOBAL_HARD_PER_MIN = 1200

/** 搜索 / LLM 的**固定窗口**长度（秒）。plan §5 的桶按分钟切。 */
export const RATE_WINDOW_SEC = 60
/** 突发窗口长度（秒）。 */
export const BURST_WINDOW_SEC = 10
/** 突发被触发后的封禁时长（秒，plan §6：block_until = now + 60s）。 */
export const BURST_BLOCK_SEC = 60

/**
 * 国家码归一化：`cn` / ` CN ` / `Cn` → `CN`；非 2 字母（含空串/空白）→ undefined。
 * （只接受 ISO-3166 alpha-2 形状，防止把 `x-prism-country` 里的脏值当成有效国家码。）
 */
export function normalizeCountry(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined
  const v = raw.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(v) ? v : undefined
}

/**
 * ASN 归一化：`"AS4134"` / `" as4134 "` / `4134` → `"4134"`；非法 → undefined。
 * （Pages Function 只发纯数字，但直连/未来改造可能带 `AS` 前缀，这里统一吃掉。）
 */
export function normalizeAsn(raw: string | number | null | undefined): string | undefined {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? String(raw) : undefined
  if (typeof raw !== "string") return undefined
  const v = raw.trim().toUpperCase().replace(/^AS/, "").trim()
  return /^[0-9]{1,10}$/.test(v) ? v : undefined
}

/** 是否属于「已知境外云/托管 ASN」（诊断用，不参与分档）。 */
export function isKnownHostingAsn(asn: string | null | undefined): boolean {
  const v = normalizeAsn(asn)
  return v !== undefined && OVERSEAS_HOSTING_ASN.has(v)
}

/**
 * 分档判定（纯函数，plan §4）。
 * @param input.loggedIn 是否持有有效会话（true 直接压过一切网络元数据）
 * @param input.country  真实客户端国家码（来自信任链，见 ratelimit.ts 的 resolveClientMeta）
 * @param input.asn      真实客户端 ASN（同上）
 */
export function decideTier(input: { loggedIn?: boolean; country?: string | null; asn?: string | null }): Tier {
  if (input.loggedIn === true) return "logged_in"

  const country = normalizeCountry(input.country ?? undefined)
  const asn = normalizeAsn(input.asn ?? undefined)
  // 缺任一 → unknown（最保守）。注意：**不要**在这里对 CN 做「只缺 ASN 就当 cn_other」的放宽，
  // plan §4 明确 unknown = 取不到 country **或** ASN。
  if (!country || !asn) return "unknown"
  if (country !== "CN") return "overseas"

  if (CN_RESIDENTIAL_ASN.has(asn)) return "cn_residential"
  if (CN_IDC_ASN.has(asn)) return "cn_idc"
  return "cn_other"
}

/**
 * 从任意 env 对象安全读字符串字段。
 * 参数类型故意放宽为 `unknown`：接线时可直接传 `c.env`（与 quota.ts 同一套做法，避免
 * `Env` interface 无索引签名导致的 TS2345）。
 */
function envString(env: unknown, key: string): string | undefined {
  if (typeof env !== "object" || env === null) return undefined
  const v = (env as Record<string, unknown>)[key]
  return typeof v === "string" ? v : undefined
}

/** 解析正整数 env；缺省/非法/<=0 → fallback（可传入非整数，例如 LLM 除数）。 */
function envNumber(env: unknown, key: string, fallback: number): number {
  const raw = envString(env, key)
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 该档的搜索限额（次/分钟）：env 可覆盖，非法值回默认。恒为正整数。 */
export function limitForTier(tier: Tier, env: unknown = {}): number {
  const fallback = TIER_DEFAULT_LIMITS[tier] ?? TIER_DEFAULT_LIMITS.unknown
  return Math.floor(envNumber(env, TIER_LIMIT_ENV[tier] ?? TIER_LIMIT_ENV.unknown, fallback))
}

/** LLM 除数（plan §4.0）：env `RATE_LIMIT_LLM_DIVISOR`，默认 5，可改 4。 */
export function llmDivisor(env: unknown = {}): number {
  return envNumber(env, "RATE_LIMIT_LLM_DIVISOR", DEFAULT_LLM_DIVISOR)
}

/**
 * LLM 端点限额（次/分钟）= `ceil(搜索限额 / 除数)`，**下限 1**
 * （plan §4.0：不能因为取整变 0；`ceil` 是向上取整，不是四舍五入）。
 */
export function llmLimitForTier(tier: Tier, env: unknown = {}): number {
  const divisor = llmDivisor(env)
  const search = limitForTier(tier, env)
  if (!Number.isFinite(divisor) || divisor <= 0) return Math.max(1, search)
  return Math.max(1, Math.ceil(search / divisor))
}

/** 单 IP 突发阈值（10 秒窗口）：env `BURST_PER_10S`，默认 20。 */
export function burstPer10s(env: unknown = {}): number {
  return Math.floor(envNumber(env, "BURST_PER_10S", DEFAULT_BURST_PER_10S))
}

/** 全局匿名软熔断阈值（次/分钟）：env `ANON_GLOBAL_PER_MIN`，默认 600。 */
export function anonGlobalLimit(env: unknown = {}): number {
  return Math.floor(envNumber(env, "ANON_GLOBAL_PER_MIN", DEFAULT_ANON_GLOBAL_PER_MIN))
}

/**
 * 全局匿名硬熔断阈值（次/分钟）：env `ANON_GLOBAL_HARD_PER_MIN`，默认 1200。
 * 恒保证 `hard >= soft`（否则「先软后硬」的语义会被配置颠倒）：配置成 hard < soft 时抬到 soft。
 */
export function anonGlobalHardLimit(env: unknown = {}): number {
  const soft = anonGlobalLimit(env)
  const hard = Math.floor(envNumber(env, "ANON_GLOBAL_HARD_PER_MIN", DEFAULT_ANON_GLOBAL_HARD_PER_MIN))
  return Math.max(soft, hard)
}
