// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf shared types
// 依据 plan.md §9 模块划分与 §3.3 请求/响应草案。此为骨架版，后续逐步补字段。

/** Workers 运行时环境绑定。Key 一律来自 secrets，绝不硬编码。 */
export interface Env {
  // ── Key Pool secrets（逗号分隔的一组 key，只存 secret）──
  EMBED_POOL_KEYS?: string
  LLM_POOL_KEYS?: string
  /** rerank 独立池（可选；缺省并入 LLM_POOL_KEYS，见 plan §2）。只影响 ref 命名与 key 禁用映射。 */
  RERANK_POOL_KEYS?: string

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

  // ── 反向代理信任链（P0：Pages Function 反代后拿不到真实客户端 IP）──
  /**
   * 与 Pages Function 共享的代理密钥，用于 `x-prism-proxy` 头（见 ratelimit.ts 的信任链注释）。
   * **必须在两处设成同一个值**：Pages 项目的 `PROXY_SHARED_SECRET`（env/vars）
   * 与 Worker 的 `PROXY_SHARED_SECRET`（secret），值不一致 = 凭据校验失败 = 退回老逻辑。
   * 不设（或只有一边设）：退化为直连逻辑（cf-connecting-ip → x-forwarded-for），
   * 此时经 Pages 反代的请求会把 CF 内部地址（如 `2a06:98c0:3600::103`）当客户端 IP。
   * 该值只用于「是否来自我们的代理」的判定，**绝不回显**（whoami 只回布尔）。
   */
  PROXY_SHARED_SECRET?: string

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
  /** X OAuth scope（空格/逗号分隔）；缺省 `users.read`。回滚用：`users.read tweet.read` */
  X_OAUTH_SCOPES?: string

  // ── 配额（T3.2：滚动 5 小时窗口 + 加权 token）──
  /** 窗口额度（加权 token），默认 300000 */
  QUOTA_WINDOW_TOKENS?: string
  /** 窗口长度（小时），默认 5 */
  QUOTA_WINDOW_HOURS?: string
  /** 未登录是否只走关键词回退（默认 "1"=是；"0"=放开完整检索，仅靠限流挡滥用） */
  REQUIRE_LOGIN?: string
  /** 单 IP 限流（次/分钟），默认 20；匿名放开检索后这是主要成本闸门 */
  RATE_LIMIT_IP_PER_MIN?: string
  /** 单账号限流（次/分钟），默认 60 */
  RATE_LIMIT_ACCOUNT_PER_MIN?: string

  // ── 分档限流（plan-ratelimit.md §4；D1 权威计数，见 src/tiers.ts / src/ratecount.ts）──
  // 全部可选；缺省用 plan §4 的默认值。**这些是"每分钟次数"的阈值，可随流量调，不含任何密钥。**
  /** logged_in 档（有效会话）：默认 60 */
  RATE_LIMIT_LOGGED_IN_PER_MIN?: string
  /** cn_residential 档（CN 家宽/移动/教育网）：默认 30 */
  RATE_LIMIT_CN_RESIDENTIAL_PER_MIN?: string
  /** cn_other 档（CN 其它 ASN）：默认 15 */
  RATE_LIMIT_CN_OTHER_PER_MIN?: string
  /** cn_idc 档（CN 云/机房）：默认 6（刻意低于境外） */
  RATE_LIMIT_CN_IDC_PER_MIN?: string
  /** overseas 档（非 CN）：默认 10 */
  RATE_LIMIT_OVERSEAS_PER_MIN?: string
  /** unknown 档（取不到 country/asn）：默认 5（最保守） */
  RATE_LIMIT_UNKNOWN_PER_MIN?: string
  /** LLM 端点限额除数：LLM 限额 = ceil(搜索限额/除数)，默认 5，可改 4；下限恒为 1 */
  RATE_LIMIT_LLM_DIVISOR?: string
  /** 单 IP 突发阈值（10 秒窗口内请求数），默认 20；超过 → 429 + 封禁 60s */
  BURST_PER_10S?: string
  /** 全局匿名软熔断阈值（次/分钟），默认 600；超过 → 匿名只走关键词回退（不调 embedding/rerank） */
  ANON_GLOBAL_PER_MIN?: string
  /** 全局匿名硬熔断阈值（次/分钟），默认 1200；超过 → 匿名一律 429（登录用户不受影响） */
  ANON_GLOBAL_HARD_PER_MIN?: string
  /** 过期计数行的清理频率（每 N 次受限请求顺手删一批），默认 200；**不引入定时任务** */
  RATE_COUNT_PURGE_EVERY?: string

  // ── LLM（T3.4 / T3.5）──
  LLM_MODEL?: string
  LLM_ENDPOINT?: string
  LLM_TIMEOUT_MS?: string
  LLM_MAX_TOKENS?: string
  /** false | true | omit（不吃该参数的模型用 omit） */
  LLM_ENABLE_THINKING?: string
  /** 自定义模型 api_key 的 AES-GCM 加密密钥（缺失则相关接口 503，绝不落明文） */
  CUSTOM_MODEL_ENC_KEY?: string
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
    /** 诊断（延迟剖析）：限流闸门耗时（KV + D1 分档计数） */
    gate_ms?: number
    /** 诊断（延迟剖析）：配额扣减 + 视图耗时 */
    quota_ms?: number
    /** 诊断（延迟剖析）：**整个 handler** 从入口到响应构造的耗时（含上面两项与检索管线） */
    handler_ms?: number
  }
  quota: { used_pct: number; remaining_pct: number; fallback: boolean }
  warnings: string[]
  answer?: { text: string; citations: string[]; model: string }
  /** 降级分支标记（plan §5.4：回退时带 fallback:true，前端展示 banner）。 */
  fallback?: boolean
  notice?: string
}
