// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 返回条数（top-k）策略：边界、匿名夹取、rerank 过采样（plan-topk.md §0/§3.1/§3.2）
//
// 本模块是**纯函数**（不读 env 之外的东西、无 IO、无网络），因为它是三处代码的**唯一真相源**：
//   · `search.ts` 的 `validate()` 用它做边界校验、rerank 用它算候选数；
//   · `quota.ts` 的 `computeQuotaCost()` 用**同一个**候选数函数算 rerank 成本 —— 两边绝不会漂移；
//   · `index.ts` 的路由用它做匿名夹取。
//
// ── 为什么候选数与成本要共用一份实现 ──
// 成本 = f(候选数)，而候选数 = g(n, env)。如果 quota 自己再写一遍 g，改了过采样系数就会出现
// "实际打了 64 条候选、却按 30 条收费"这类静默不一致（本项目的对外声明必须与代码行为逐条一致，
// history.md 坑 41）。所以 g 只在这里实现一次。
//
// ── 与限流的关系（plan-topk.md §0 决策 3：模型 A）──
// 限流**只管请求频率，与 n 无关**（embed + Qdrant 的固定成本与 n 无关，按 n 反向缩放会让
// n=1 的请求数上限放大 10 倍 → 推高上游压力 = 提高被上游判滥用的风险）。
// n 的差异**只通过配额**体现：纯检索恒定 200；rerank 按候选数线性。

/** `top_k` 允许范围与默认值（plan-topk.md §3.1）。 */
export const TOP_K_MIN = 1
export const TOP_K_MAX = 50
export const TOP_K_DEFAULT = 10

/** 未登录（无有效会话）时的返回条数上限；超出**夹取**而非报错（§3.1）。 */
export const ANON_TOP_K_MAX = 5

/** 匿名夹取时追加到响应 `warnings` 的标记（前端据此给非错误提示）。 */
export const ANON_TOP_K_WARNING = "top-k-clamped-anon"

/** rerank 过采样系数默认值（保持现状 3×，不为省成本降质量 —— §0 决策 5）。 */
export const DEFAULT_RERANK_OVERFETCH = 3
/**
 * rerank 候选数上限默认值：**64**。
 * 为什么是 64：rerank 上游（硅基流动）单次 HTTP 批量 32 条 → 64 恰好 **2 批**，不多不少；
 * 而"每次请求的 rerank 调用次数 ≤2 批"正是本设计里唯一有真实依据的计费口径（§0 决策 6）。
 */
export const DEFAULT_RERANK_MAX_CANDIDATES = 64

/** 解析正整数 env；缺省/非法/<=0 → fallback。 */
function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function envString(env: unknown, key: string): string | undefined {
  if (typeof env !== "object" || env === null) return undefined
  const v = (env as Record<string, unknown>)[key]
  return typeof v === "string" ? v : undefined
}

/** rerank 过采样系数：env `RERANK_OVERFETCH`，默认 3。 */
export function rerankOverfetch(env: unknown = {}): number {
  return envInt(envString(env, "RERANK_OVERFETCH"), DEFAULT_RERANK_OVERFETCH)
}

/** rerank 候选数上限：env `RERANK_MAX_CANDIDATES`，默认 64。 */
export function rerankMaxCandidates(env: unknown = {}): number {
  return envInt(envString(env, "RERANK_MAX_CANDIDATES"), DEFAULT_RERANK_MAX_CANDIDATES)
}

/**
 * 给 rerank 的候选集条数。**优先级（高 → 低）**：
 *   1. `env.RERANK_TOP_K` —— **显式绝对覆盖**（向后兼容，老部署/压测脚本仍在用；设了就完全按它，
 *      不再乘系数、也不再受 MAX_CANDIDATES 约束 —— 语义就是"我就要这么多候选"）；
 *   2. 否则 `min(ceil(RERANK_OVERFETCH × n), RERANK_MAX_CANDIDATES)`，并**不低于 n**
 *      （候选少于 n 时用户拿不满 n 条，那是 bug 不是省成本）。
 *
 * 例（默认 3× / 封顶 64）：n=1→3；n=5→15；n=10→30；n=20→60；n≥22→64。
 * ⚠️ n≥22 时实际过采样倍数 <3×（n=50 → 1.28×）：这是**有意**的（§6 第 6 条）——
 * 用户要 50 条时本来就想"尽量多拿"，再多筛收益小、延迟代价大。
 */
export function rerankCandidateLimit(env: unknown, topK: number): number {
  const explicit = envString(env, "RERANK_TOP_K")
  if (explicit !== undefined && explicit.trim() !== "") {
    const n = Number(explicit)
    if (Number.isFinite(n) && n >= 1) return Math.floor(n)
  }
  const byOverfetch = Math.ceil(topK * rerankOverfetch(env))
  return Math.max(topK, Math.min(byOverfetch, rerankMaxCandidates(env)))
}

/** 匿名夹取结果。 */
export interface AnonTopKClamp {
  /** 实际使用的条数 */
  topK: number
  /** 是否发生了夹取（true → 调用方应在响应 warnings 里加 `top-k-clamped-anon`） */
  clamped: boolean
}

/**
 * 未登录时的条数夹取（plan-topk.md §3.1）：`top_k > ANON_TOP_K_MAX` → 夹到 5，**不报错**。
 * 为什么夹取而不是 422：手写客户端不会因为多要几条就彻底失败，同时前端能明确提示"登录后可到 50"。
 * ⚠️ 调用方必须在**实际检索之前**夹取（否则 embed/rerank 已经白花），登录用户不受此限。
 */
export function clampTopKForAnon(topK: number | undefined, loggedIn: boolean): AnonTopKClamp {
  const n = Number.isInteger(topK) ? (topK as number) : TOP_K_DEFAULT
  if (loggedIn || n <= ANON_TOP_K_MAX) return { topK: n, clamped: false }
  return { topK: ANON_TOP_K_MAX, clamped: true }
}
