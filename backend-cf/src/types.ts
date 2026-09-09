// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf shared types
// 依据 plan.md §9 模块划分与 §3.3 请求/响应草案。此为骨架版，后续逐步补字段。

/** Workers 运行时环境绑定。Key 一律来自 secrets，绝不硬编码。 */
export interface Env {
  // ── Key Pool secrets（逗号分隔的一组 key，只存 secret）──
  EMBED_POOL_KEYS?: string
  LLM_POOL_KEYS?: string

  // ── D1 / KV / Queue 绑定 ──
  DB: D1Database
  SEARCH_CACHE: KVNamespace
  INGEST_QUEUE: Queue

  // ── Qdrant Cloud（可选，M0 探测/后续接入）──
  QDRANT_URL?: string
  QDRANT_API_KEY?: string

  // ── 硅基流动中国站配置（可被 secrets/vars 覆盖）──
  EMBEDDING_ENDPOINT?: string
  EMBEDDING_MODEL?: string
  EMBEDDING_DIM?: string
  RERANK_ENDPOINT?: string
  RERANK_MODEL?: string
  /** 给 rerank 的候选集上限（tasks.md T1.1：删掉旧魔法数字，改成配置项）。默认取前 top_k*入库检索每库 limit 合并后的前 N 条。 */
  RERANK_TOP_K?: string

  // ── 超时配置（T1.3，毫秒；默认 15s）──
  EMBED_TIMEOUT_MS?: string
  RERANK_TIMEOUT_MS?: string
  QDRANT_TIMEOUT_MS?: string

  // ── 其它 ──
  ADMIN_API_KEY?: string
  ALLOWED_ORIGINS?: string

  // ── 登录（T3.1，X OAuth 2.0 + PKCE）──
  /** X 开发者后台 OAuth 2.0 Client ID */
  X_CLIENT_ID?: string
  /** X 开发者后台 OAuth 2.0 Client Secret */
  X_CLIENT_SECRET?: string
  /** 回调地址，必须与 X 后台登记的 Redirect URI 完全一致 */
  OAUTH_REDIRECT_URI?: string
  /** 登录成功后回跳的前端基址（如 https://search.chengxi.moe） */
  FRONTEND_BASE_URL?: string
  /** 会话 JWT 签名密钥（HS256） */
  JWT_SECRET?: string
  /** 管理员 X 数字 id，逗号分隔 */
  ADMIN_X_IDS?: string
}

/** 一次搜索的请求体（plan.md §3.3）。M0 只实现 corpora=["mtf-wiki"]。 */
export interface SearchRequest {
  query: string
  corpora: string[]
  use_reranker?: boolean
  use_llm?: boolean
  llm_mode?: "summary" | "chat"
  session_id?: string
  top_k?: number
  model_id?: string | "default"
}

/** 搜索结果命中项（plan.md §3.3 返回体）。 */
export interface SearchHit {
  id: string
  title: string
  url: string
  source: string
  path: string
  snippet: string
  score: number
  rerank_score?: number
}

/** 搜索响应（骨架版，字段随 M1/M3 逐步补全）。 */
export interface SearchResponse {
  hits: SearchHit[]
  timings: {
    embed_ms: number
    search_ms: number
    rerank_ms: number
    llm_ms: number
    total_ms: number
    /** T1.2：命中短期向量缓存时为 true（跳过 embed+Qdrant；rerank 仍重算）。缺省视作 false。 */
    cached?: boolean
  }
  quota: { used_h: number; remaining_h: number; fallback: boolean }
  warnings: string[]
  answer?: { text: string; citations: string[]; model: string }
  /** 降级分支标记（plan §5.4：回退时带 fallback:true，前端展示 banner）。 */
  fallback?: boolean
  notice?: string
}
