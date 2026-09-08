// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — useApi composable
// 只调自家 API（/api/v1/search）。类型按 plan.md §3.3。
// 前端永不直连任何模型 key；所有调用走后端代理（dev 下经 devProxy → 本地 Workers）。

/** 单条命中结果（plan.md §3.3） */
export interface SearchHit {
  id: string
  title: string
  url: string
  /** wiki 名，如 "MtF Wiki" / "FtM Wiki" / "RLE Wiki" / "Mio MtF Wiki" */
  source: string
  /** 章节路径 */
  path: string
  /** 原文片段 */
  snippet: string
  /** 向量/重排分数 */
  score: number
  rerank_score?: number
}

/** 耗时拆解（plan.md §3.3 / T0.4） */
export interface SearchTimings {
  embed_ms: number
  search_ms: number
  rerank_ms: number
  llm_ms: number
  total_ms: number
  cached?: boolean
}

/** 配额信息（plan.md §3.4） */
export interface SearchQuota {
  used_h: number
  remaining_h: number
  fallback: boolean
}

/** 可选 LLM 总结（plan.md §3.3） */
export interface SearchAnswer {
  text: string
  citations: string[]
  model: string
}

/** POST /api/v1/search 请求体（plan.md §3.3 / T0.4） */
export interface SearchRequest {
  query: string
  /** 向量库范围：mtf-wiki | ftm-wiki | rle-wiki | miomtfwiki */
  corpora: string[]
  use_reranker: boolean
  use_llm: boolean
  llm_mode?: "summary" | "chat"
  session_id?: string
  top_k?: number
  model_id?: string
}

/** POST /api/v1/search 返回体 */
export interface SearchResponse {
  hits: SearchHit[]
  timings: SearchTimings
  quota: SearchQuota
  fallback: boolean
  warnings: string[]
  answer?: SearchAnswer
}

/** 可选的 vector 库选项 */
export interface CorpusOption {
  id: string
  name: string
  shortName: string
  code: string
  desc?: string
}

export function useApi() {
  const config = useRuntimeConfig()

  function baseURL(): string {
    // 默认 "/api"，dev 下经 devProxy 转发到本地 Workers；生产可用 NUXT_PUBLIC_API_BASE 覆盖
    return (config.public.apiBase as string) || "/api"
  }

  async function request<T>(
    path: string,
    opts?: RequestInit & { params?: Record<string, string | number | undefined | null> },
  ): Promise<T> {
    let url = `${baseURL()}${path}`
    if (opts?.params) {
      const qs = Object.entries(opts.params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      if (qs) url += `?${qs}`
    }

    const res = await fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(opts?.headers as Record<string, string>),
      },
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error((data as { detail?: string | string[] })?.detail?.toString() ?? `HTTP ${res.status}`)
    }
    return data as T
  }

  /**
   * 语义搜索（POST /api/v1/search）。
   * 四库已于 Qdrant Cloud 闭环，支持单库或多库并行检索。
   */
  async function search(params: SearchRequest): Promise<SearchResponse> {
    return request<SearchResponse>("/v1/search", {
      method: "POST",
      body: JSON.stringify(params),
    })
  }

  return { search, baseURL }
}

/** 前端 corpora 四库完整选项（MtF / FtM / RLE / MioMtF） */
export const DEFAULT_CORPORA_OPTIONS: CorpusOption[] = [
  {
    id: "mtf-wiki",
    name: "MtF Wiki",
    shortName: "MtF",
    code: "MTF",
    desc: "跨性别女性信息与医疗指引",
  },
  {
    id: "ftm-wiki",
    name: "FtM Wiki",
    shortName: "FtM",
    code: "FTM",
    desc: "跨性别男性信息与医疗指引",
  },
  {
    id: "rle-wiki",
    name: "RLE Wiki",
    shortName: "RLE",
    code: "RLE",
    desc: "真实生活体验（Real Life Experience）知识库",
  },
  {
    id: "miomtfwiki",
    name: "Mio MtF",
    shortName: "Mio",
    code: "MIO",
    desc: "Mio MtF 整合知识库",
  },
]
