// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 检索偏好（tasks.md T3.6 /settings；plan-topk.md 增"返回条数"）
// 只存 localStorage（键 `prism_prefs`），不涉账号数据、不涉任何 key。
// 覆盖：默认知识库 / 精准重排默认开 / AI 伴读默认开 / 返回条数（top_k）。

import { ALL_CORPUS_IDS } from "~/composables/useApi"

export interface PrismPrefs {
  /** 默认勾选的知识库（至少 1 个） */
  corpora: string[]
  /** 精准重排（reranker）默认开 */
  reranker: boolean
  /** AI 伴读默认开（默认关，开启需二次确认并消耗配额） */
  llm: boolean
  /**
   * 返回条数（top_k），1–50，默认 10（plan-topk.md §3.1）。
   * 未登录时前端**只允许 1–5**（后端也会夹取，两侧一致）；因此本地存的值在未登录态展示时会被夹到 5。
   */
  topK: number
  /**
   * 偏好结构版本。
   * · v1（无该字段）/v2：曾把"未登录被夹到 5"或更早的默认 2 持久化下来（bug 产物）；
   * · v3（当前）：迁移时把 <8 的历史值一次性提升到默认 10；**≥8 的值视为用户真实偏好并保留**。
   */
  version: number
}

/** 当前偏好结构版本（<2 的历史数据会在 sanitize 里一次性修正） */
export const PREFS_VERSION = 3

export const PREFS_KEY = "prism_prefs"

/** 返回条数边界（与后端 src/topk.ts 的 TOP_K_MIN/MAX/DEFAULT、匿名上限 5 保持一致）。 */
export const TOP_K_MIN = 1
export const TOP_K_MAX = 50
export const TOP_K_DEFAULT = 10
export const TOP_K_ANON_MAX = 5

export function defaultPrefs(): PrismPrefs {
  return { corpora: [...ALL_CORPUS_IDS], reranker: true, llm: false, topK: TOP_K_DEFAULT, version: PREFS_VERSION }
}

/** 夹到 [1, 50] 的整数；非法 → 默认 10。 */
export function clampTopK(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return TOP_K_DEFAULT
  return Math.min(TOP_K_MAX, Math.max(TOP_K_MIN, Math.round(n)))
}

function sanitize(raw: unknown): PrismPrefs {
  const base = defaultPrefs()
  if (!raw || typeof raw !== "object") return base
  const obj = raw as Partial<PrismPrefs>
  const corpora = Array.isArray(obj.corpora)
    ? obj.corpora.filter((c): c is string => typeof c === "string" && ALL_CORPUS_IDS.includes(c))
    : []
  const storedVersion = typeof obj.version === "number" ? obj.version : 0
  const storedTopK = obj.topK === undefined ? base.topK : clampTopK(obj.topK)
  // 迁移历史：v1（无版本号）与 v2 都曾被"匿名上限夹取"或旧默认污染过 topK（实测残留 2 与 5）。
  // 这类值不是用户的明确选择、而是 bug 产物 → 一次性提升到默认 10；
  // **≥8 的值视为用户真实偏好，一律保留**（例如有人就想要 20 条）。
  const topK = storedVersion < 3 && storedTopK < 8 ? base.topK : storedTopK
  return {
    corpora: corpora.length ? corpora : base.corpora,
    reranker: typeof obj.reranker === "boolean" ? obj.reranker : base.reranker,
    llm: typeof obj.llm === "boolean" ? obj.llm : base.llm,
    topK,
    version: PREFS_VERSION,
  }
}

/** 检索偏好状态（useState 共享；localStorage 持久化，服务端渲染安全） */
export function usePrefs() {
  const prefs = useState<PrismPrefs>("prism:prefs", defaultPrefs)

  /** 客户端首次进入时从 localStorage 载入（幂等） */
  function load(): PrismPrefs {
    if (typeof window === "undefined") return prefs.value
    try {
      const raw = window.localStorage.getItem(PREFS_KEY)
      if (raw) prefs.value = sanitize(JSON.parse(raw))
    } catch {
      // 解析失败/存储不可用 → 保持默认
    }
    return prefs.value
  }

  function save(patch: Partial<PrismPrefs>): PrismPrefs {
    prefs.value = sanitize({ ...prefs.value, ...patch })
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value))
      } catch {
        // 存储不可写：本次会话内仍然生效
      }
    }
    return prefs.value
  }

  function reset(): PrismPrefs {
    return save(defaultPrefs())
  }

  return { prefs, load, save, reset }
}
