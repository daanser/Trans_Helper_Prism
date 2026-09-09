// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 检索偏好（tasks.md T3.6 /settings）
// 只存 localStorage（键 `prism_prefs`），不涉账号数据、不涉任何 key。
// 覆盖：默认知识库 / 精准重排默认开 / AI 伴读默认开。

import { ALL_CORPUS_IDS } from "~/composables/useApi"

export interface PrismPrefs {
  /** 默认勾选的知识库（至少 1 个） */
  corpora: string[]
  /** 精准重排（reranker）默认开 */
  reranker: boolean
  /** AI 伴读默认开（默认关，开启需二次确认并消耗配额） */
  llm: boolean
}

export const PREFS_KEY = "prism_prefs"

export function defaultPrefs(): PrismPrefs {
  return { corpora: [...ALL_CORPUS_IDS], reranker: true, llm: false }
}

function sanitize(raw: unknown): PrismPrefs {
  const base = defaultPrefs()
  if (!raw || typeof raw !== "object") return base
  const obj = raw as Partial<PrismPrefs>
  const corpora = Array.isArray(obj.corpora)
    ? obj.corpora.filter((c): c is string => typeof c === "string" && ALL_CORPUS_IDS.includes(c))
    : []
  return {
    corpora: corpora.length ? corpora : base.corpora,
    reranker: typeof obj.reranker === "boolean" ? obj.reranker : base.reranker,
    llm: typeof obj.llm === "boolean" ? obj.llm : base.llm,
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
