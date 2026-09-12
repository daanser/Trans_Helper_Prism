// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — useApi composable
// 只调自家 API（baseURL + /v1/...）。类型按 plan.md §3.3 / tasks.md T3.6。
// 前端永不直连任何模型 key；所有调用走后端代理（dev 下经 vite.server.proxy → 本地 Workers）。
// ⚠️ history §5 坑 8：baseURL 已含 `/api`，因此 search 传 `/v1/search`，不要双拼。
// ⚠️ history §5 坑 18：NUXT_PUBLIC_API_BASE 必须带 `/api` 后缀。

import { authHeader, readAuthToken } from "~/utils/authToken"

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

/** 配额信息（T3.2 新契约：滚动窗口 + 百分比；字段缺失时前端降级不显示）
 *  - `used_pct` / `remaining_pct` 为 0–100 的数（1 位小数）
 *  - `window_start` 为窗口起点毫秒时间戳，`window_hours` 为窗口长度（小时）
 */
export interface QuotaState {
  window_start?: number | null
  window_hours?: number | null
  limit_tokens?: number | null
  used_tokens?: number | null
  used_pct?: number | null
  remaining_pct?: number | null
  exceeded?: boolean
  /** 后端标记「降级计量」（如 DB 不可用时放行），仅作提示，不影响展示 */
  degraded?: boolean
  /** POST /search 的 quota 会带 fallback 标记（是否走了关键词回退） */
  fallback?: boolean
}

/** GET /api/v1/me 的 user 字段 */
export interface MeUser {
  account_id: string
  handle: string
  role: string
  created_at: number
}

/** GET /api/v1/me 返回体 */
export interface MeResponse {
  user: MeUser
  quota: QuotaState
  /**
   * 免责声明确认时刻（epoch ms）；`null` = 从未确认。
   * 字段可选：老部署没有这两列时前端视为"未确认"（只是会弹一次，不影响任何功能）。
   */
  disclaimer_ack_at?: number | null
  /** `disclaimer_ack_at !== null` 的布尔投影（后端 /me 直接给，前端判空更方便） */
  disclaimer_ack?: boolean
}

/** POST /api/v1/me/disclaimer 返回体 */
export interface DisclaimerAckResponse {
  ok: boolean
  /** 写库后的真值（`ack:false` 时为 null） */
  disclaimer_ack_at: number | null
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
  quota: QuotaState
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

/** 自定义模型配置（tasks.md T3.5；api_key 只在提交瞬间存在内存里，绝不写 localStorage） */
export interface ModelSettingsRequest {
  /** 用户可见标签（可选，仅用于列表展示） */
  name?: string
  /** 传入已有 id 表示更新该行；缺省为新建 */
  id?: string
  base_url: string
  model: string
  api_key: string
}

/**
 * 自定义模型列表项（GET /api/v1/settings/models，T3.5，已上线）。
 * ⚠️ 后端**只回元信息**：不含 key 明文，也不含密文；
 * `key_configured` 仅表示「该行配置过 key」，恒为 true（本表只存密文，读不出明文）。
 */
export interface CustomModelListItem {
  id: string
  /** 用户可见标签，可能为空串（前端展示「未命名」） */
  name: string
  base_url: string
  model: string
  key_configured: boolean
  /** 毫秒时间戳 */
  created_at: number
  updated_at: number
}

/** GET /api/v1/settings/models 返回体 */
export interface ModelListResponse {
  models: CustomModelListItem[]
}

/** DELETE /api/v1/settings/models/:id 返回体（越权/不存在 → 404 {error:"not-found"}） */
export interface ModelDeleteResponse {
  ok?: boolean
  deleted?: number
}

/** 管理接口的宽松返回体（T3.3/T3.6，后端未定稿，页面按字段存在与否降级渲染） */
export interface AdminUsageResponse {
  items?: Record<string, unknown>[]
  accounts?: Record<string, unknown>[]
  total?: Record<string, unknown>
  [key: string]: unknown
}

export interface AdminKeysResponse {
  keys?: Record<string, unknown>[]
  items?: Record<string, unknown>[]
  [key: string]: unknown
}

/**
 * 管理端分档限流观测（GET /api/v1/admin/ratelimit）的宽松返回体。
 * 真实形状见 backend-cf/src/ratecount.ts 的 `RateLimitStats`；前端只按「字段在不在」渲染，
 * 因此全部可选 + 索引签名（后端加字段不会让前端炸）。
 */
export interface AdminRateLimitResponse {
  now?: number
  window_sec?: number
  window_start?: number
  range_start?: number
  tiers?: Array<{ tier?: unknown; buckets?: unknown; counted?: unknown; limit?: unknown }>
  scopes?: Record<string, { buckets?: unknown; counted?: unknown } | undefined>
  blocked_buckets?: number
  global?: { count?: unknown; soft?: unknown; hard?: unknown; state?: unknown }
  limits?: Record<string, unknown>
  degraded?: boolean
  [key: string]: unknown
}

/**
 * 摄取历史一行（GET /api/v1/admin/ingest/runs，M4·W4）。
 * 形状与后端 `src/ingestruns.ts` 的 `IngestRunRecord` 对齐；字段全部可选 + 索引签名
 * （后端加字段不会让前端炸，缺失字段一律显示「—」）。
 */
export interface AdminIngestRun {
  id?: string
  wiki_id?: string
  commit_sha?: string
  status?: string
  files_added?: number
  files_updated?: number
  files_deleted?: number
  points_upserted?: number
  points_deleted?: number
  tokens_used?: number
  duration_ms?: number | null
  error?: string | null
  started_at?: number
  finished_at?: number | null
  [key: string]: unknown
}

/** GET /api/v1/admin/ingest/runs 返回体 */
export interface AdminIngestRunsResponse {
  runs?: AdminIngestRun[]
  limit?: number
  [key: string]: unknown
}

export interface AdminBanRequest {
  account_id: string
  banned: boolean
  reason?: string
}

export interface AdminQuotaRequest {
  account_id: string
  /** 增减额度（正数加额、负数扣减）；后端按 token 计，字段同时带 delta_pct 以兼容百分比口径 */
  delta: number
  /** 重置当前窗口（后端支持） */
  reset?: boolean
  reason?: string
}

/**
 * 429 分档限流的附加字段（后端 `rateLimitedResponse`：`{error:"rate-limited", tier, scope, retry_after}`
 * + `Retry-After` / `X-RateLimit-Limit` 头，见 plan-ratelimit.md §4/§6）。
 * 全部可选：老部署 / KV 粗限流路径不带这些字段时，字段为 undefined，调用方按缺省文案降级。
 */
export interface ApiErrorDetails {
  /** 建议等待秒数（体里的 `retry_after` 优先，其次 `Retry-After` 头） */
  retryAfter?: number
  /** 档位：logged_in / cn_residential / cn_other / cn_idc / overseas / unknown */
  tier?: string
  /** 限流作用域：tier-limit / burst / blocked / global-hard */
  scope?: string
  /** 本次生效限额（次/窗口；来自 `X-RateLimit-Limit` 头） */
  limit?: number
}

/** 带 HTTP 状态码的错误，便于区分「接口未实现（404/501）」与真实故障 */
export class ApiError extends Error {
  status: number
  code: string
  /** 429 分档限流的字段（非 429 时全部为 undefined） */
  retryAfter?: number
  tier?: string
  scope?: string
  limit?: number

  constructor(message: string, status: number, code = "", details: ApiErrorDetails = {}) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryAfter = details.retryAfter
    this.tier = details.tier
    this.scope = details.scope
    this.limit = details.limit
  }

  /**
   * 是否「按 IP 分档限流」的 429。
   * ⚠️ 必须同时看 `code === "rate-limited"`：**额度耗尽**（`quota-exceeded`）也是 429，
   * 但语义完全不同（走回退检索、不封禁），前端不能混为一谈（见 index.vue 的提示分支）。
   */
  get rateLimited(): boolean {
    return this.status === 429 && this.code === "rate-limited"
  }
}

/** 从任意值里取有限正数（用于 header/body 的宽松解析）。 */
function positiveNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * 429（或任意错误）响应的限流附加信息：体里的字段优先，头作兜底。
 * 绝不解析/记录 Authorization 等任何秘密（只读 Retry-After / X-RateLimit-* 与已知体字段）。
 */
function rateLimitDetails(res: Response, data: Record<string, unknown>): ApiErrorDetails {
  const fromBody = positiveNumber(data?.retry_after)
  const fromHeader = positiveNumber(res.headers.get("Retry-After"))
  const limit = positiveNumber(res.headers.get("X-RateLimit-Limit"))
  return {
    retryAfter: fromBody ?? fromHeader,
    tier: typeof data?.tier === "string" && data.tier ? data.tier : undefined,
    scope: typeof data?.scope === "string" && data.scope ? data.scope : undefined,
    limit,
  }
}

/** 后端未实现（404 路由缺失 / 501 占位）判定：T3.4/T3.5/T3.3 未定稿接口全部走这里 */
export function isUnimplemented(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  return status === 404 || status === 501
}

/** 是否「分档限流」的 429（额度过尽的 429 `quota-exceeded` **不算**）。 */
export function isRateLimited(err: unknown): boolean {
  const e = err as ApiError | undefined
  if (e?.rateLimited === true) return true
  // 兜底：非 ApiError（例如被序列化过）时只看 status+code
  return (e as { status?: number })?.status === 429 && (e as { code?: string })?.code === "rate-limited"
}

/** SSE 流式回调（POST /api/v1/search/stream）
 *  实际后端事件：event: hits|session|citations|delta|done|error，payload 均在 `data:` 行。
 */
export interface SearchStreamHandlers {
  /** 增量文本：兼容 `{text}` / `{delta}` / `{content}` */
  onDelta?: (delta: string) => void
  onHits?: (hits: SearchHit[]) => void
  onCitations?: (citations: string[]) => void
  onMeta?: (meta: { model?: string }) => void
  /** 多轮会话 id（后续追问走 POST /v1/chat） */
  onSession?: (sessionId: string, maxRounds?: number) => void
  /** 上游 LLM 不可用时的友好提示（event: error → {code, notice}） */
  onNotice?: (notice: string) => void
}

/** POST /api/v1/chat 返回体（T3.4 多轮追问，非流式） */
export interface ChatResponse {
  text: string
  citations?: string[]
  model?: string
  tokens_in?: number
  tokens_out?: number
  estimated?: boolean
}

/** 后端 citations 既可能是 "来源1" 字符串，也可能是 {index,label,...} 对象 → 统一成展示标签 */
function normalizeCitations(list: unknown[]): string[] {
  return list
    .map((item) => {
      if (typeof item === "string") return item
      if (typeof item === "number") return String(item)
      const obj = item as Record<string, unknown>
      if (typeof obj.label === "string" && obj.label) return obj.label
      if (typeof obj.index === "number") return `来源${obj.index}`
      return ""
    })
    .filter((s) => !!s)
}

export function useApi() {
  const config = useRuntimeConfig()

  function baseURL(): string {
    // 默认 "/api"，dev 下经 vite.server.proxy 转发到本地 Workers；生产用 NUXT_PUBLIC_API_BASE 覆盖
    return (config.public.apiBase as string) || "/api"
  }

  /** 有会话 token 时自动带 Authorization: Bearer（T3.6） */
  function headers(extra?: HeadersInit): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...authHeader(),
      ...((extra as Record<string, string>) ?? {}),
    }
  }

  function buildUrl(path: string, params?: Record<string, string | number | undefined | null>): string {
    let url = `${baseURL()}${path}`
    if (params) {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      if (qs.length) url += `?${qs.join("&")}`
    }
    return url
  }

  async function request<T>(
    path: string,
    opts?: RequestInit & { params?: Record<string, string | number | undefined | null> },
  ): Promise<T> {
    const url = buildUrl(path, opts?.params)

    const res = await fetch(url, {
      ...opts,
      headers: headers(opts?.headers),
    })

    const data = (await res.json().catch(() => ({}))) as {
      detail?: string | string[]
      error?: string
    }
    if (!res.ok) {
      const detail = data?.detail
      const code = typeof data?.error === "string" ? data.error : ""
      const message = Array.isArray(detail)
        ? detail.join("；")
        : detail?.toString() || code || `HTTP ${res.status}`
      // 429：把 retry_after / tier / scope / limit 一并带出（前端据此做倒计时与档位提示）
      throw new ApiError(message, res.status, code, rateLimitDetails(res, data as Record<string, unknown>))
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

  /** 当前账号 + 配额（GET /api/v1/me，需 Bearer） */
  async function me(): Promise<MeResponse> {
    return request<MeResponse>("/v1/me")
  }

  /**
   * 记录/撤销「免责声明已确认」（POST /api/v1/me/disclaimer，需 Bearer）。
   * `ack=true` → 服务端记时间戳（换设备不再弹）；`ack=false` → 置 NULL（设置页重新打开提示）。
   * 调用方（useDisclaimer）对失败只 warn：本地状态已经写好，不该因网络问题反复弹窗。
   */
  async function ackDisclaimer(ack: boolean): Promise<DisclaimerAckResponse> {
    return request<DisclaimerAckResponse>("/v1/me/disclaimer", {
      method: "POST",
      body: JSON.stringify({ ack }),
    })
  }

  /**
   * LLM 总结流式接口（POST /api/v1/search/stream，tasks.md T3.4）。
   * 契约：SSE，`data: {"delta":"..."}` 增量，`data: [DONE]` 结束；请求体同 /v1/search + session_id。
   * 后端尚未实现（当前 501 / 404）→ 抛 ApiError，调用方用 isUnimplemented 降级，绝不影响主检索。
   * 宽容解析：额外接受 {"hits":[...]} / {"citations":[...]} / {"model":"..."} / 裸文本 delta。
   */
  async function searchStream(
    params: SearchRequest,
    handlers: SearchStreamHandlers = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const url = buildUrl("/v1/search/stream")
    const res = await fetch(url, {
      method: "POST",
      headers: headers({ Accept: "text/event-stream" }),
      body: JSON.stringify(params),
      signal,
    })

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: string | string[]; error?: string }
      const code = typeof data?.error === "string" ? data.error : ""
      const detail = data?.detail
      const message = Array.isArray(detail) ? detail.join("；") : detail?.toString() || code || `HTTP ${res.status}`
      // SSE 路径的 429 同样带出限流字段（/search/stream 用的是 llm 桶，限额更紧）
      throw new ApiError(message, res.status, code, rateLimitDetails(res, data as Record<string, unknown>))
    }

    const contentType = res.headers.get("content-type") ?? ""
    if (!res.body || contentType.includes("application/json")) {
      // 后端没按 SSE 返回（例如把占位 501 换成了 JSON 200）→ 当作不可用处理
      throw new ApiError("stream-not-sse", res.status, "stream-not-sse")
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let done = false

    const handlePayload = (raw: string) => {
      const payload = raw.trim()
      if (!payload) return
      if (payload === "[DONE]" || payload === "DONE") {
        done = true
        return
      }
      let obj: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(payload)
        if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>
      } catch {
        // 非 JSON：按裸文本增量处理（宽容）
        handlers.onDelta?.(payload)
        return
      }
      if (!obj) {
        handlers.onDelta?.(payload)
        return
      }
      if (typeof obj.error === "string" && obj.error) {
        const notice = typeof obj.notice === "string" && obj.notice ? obj.notice : ""
        if (notice) handlers.onNotice?.(notice)
        throw new ApiError(notice || obj.error, 200, obj.error)
      }
      if (typeof obj.notice === "string" && obj.notice && typeof obj.code === "string") {
        // event: error → {code, notice}
        handlers.onNotice?.(obj.notice)
        throw new ApiError(obj.notice, 200, obj.code)
      }
      if (typeof obj.delta === "string") handlers.onDelta?.(obj.delta)
      else if (typeof obj.text === "string") handlers.onDelta?.(obj.text)
      else if (typeof obj.content === "string") handlers.onDelta?.(obj.content)

      if (Array.isArray(obj.hits)) handlers.onHits?.(obj.hits as SearchHit[])
      if (Array.isArray(obj.citations)) handlers.onCitations?.(normalizeCitations(obj.citations))
      if (typeof obj.model === "string") handlers.onMeta?.({ model: obj.model })
      if (typeof obj.session_id === "string" && obj.session_id) {
        handlers.onSession?.(obj.session_id, typeof obj.max_rounds === "number" ? obj.max_rounds : undefined)
      }
      if (obj.done === true) done = true
    }

    const consumeBuffer = (flush: boolean) => {
      const lines = buffer.split(/\r?\n/)
      buffer = flush ? "" : (lines.pop() ?? "")
      for (const line of lines) {
        if (!line || line.startsWith(":")) continue
        if (line.startsWith("data:")) handlePayload(line.slice(5))
      }
    }

    while (!done) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      consumeBuffer(false)
    }
    buffer += decoder.decode()
    consumeBuffer(true)
    if (!done) {
      // 流被上游截断但已有增量 → 由调用方按「有内容即可用」处理
      return
    }
    try {
      await reader.cancel()
    } catch {
      // 已自然结束，忽略
    }
  }

  /**
   * 多轮追问（POST /api/v1/chat，T3.4）。非流式 JSON：`{text, citations, model}`。
   * `session_id` 来自流式总结的 `event: session`；后端负责最近 N 轮上下文与 10 轮上限。
   */
  async function chat(sessionId: string, question: string): Promise<ChatResponse> {
    const res = await request<ChatResponse>("/v1/chat", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, question }),
    })
    // citations 可能是 {index,label} 对象，统一成 "来源n" 标签
    if (Array.isArray(res.citations)) res.citations = normalizeCitations(res.citations)
    return res
  }

  /** 管理端：用量（GET /api/v1/admin/usage，未定稿 → 404/501 时页面显示「接口未实现」） */
  async function adminUsage(): Promise<AdminUsageResponse> {
    return request<AdminUsageResponse>("/v1/admin/usage")
  }

  /**
   * 管理端：分档限流观测（GET /api/v1/admin/ratelimit，plan-ratelimit.md §10 R5）。
   * 只读聚合 `rate_counters`：各档/各作用域的桶数与计数、封禁行数、全局熔断状态、当前限额。
   * 缺 D1 → 503；读失败 → 503；老部署没有该路由 → 404（页面显示「接口未实现」）。
   * 字段可缺（页面按存在与否降级渲染），因此用宽松类型。
   */
  async function adminRatelimit(): Promise<AdminRateLimitResponse> {
    return request<AdminRateLimitResponse>("/v1/admin/ratelimit")
  }

  /** 管理端：审计日志（GET /api/v1/admin/audit，已实现；需 ADMIN_API_KEY） */
  async function adminAudit(limit = 30): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>("/v1/admin/audit", { params: { limit } })
  }

  /** 管理端：key 池列表（GET /api/v1/admin/keys） */
  async function adminKeys(): Promise<AdminKeysResponse> {
    return request<AdminKeysResponse>("/v1/admin/keys")
  }

  /**
   * 管理端：最近若干条摄取记录（GET /api/v1/admin/ingest/runs?limit=N，M4·W4）。
   * 后端由 GitHub Actions 在摄取结束后上报（Worker 代笔写 D1），按 finished_at 倒序返回。
   * limit 缺省 20（后端夹到 [1,200]）；老部署没有该路由 → 404（页面显示「接口未实现」）。
   */
  async function adminIngestRuns(limit = 10): Promise<AdminIngestRunsResponse> {
    return request<AdminIngestRunsResponse>("/v1/admin/ingest/runs", { params: { limit } })
  }

  /**
   * 管理端：封禁/解封。
   * 实际后端路径为 `POST /v1/admin/accounts/:id/ban?unban=1`；若 404 再回落到契约草案 `POST /v1/admin/ban`。
   */
  async function adminBan(payload: AdminBanRequest): Promise<Record<string, unknown>> {
    const query = payload.banned ? "" : "?unban=1"
    const reason = payload.reason ? `${query ? "&" : "?"}reason=${encodeURIComponent(payload.reason)}` : ""
    try {
      return await request<Record<string, unknown>>(
        `/v1/admin/accounts/${encodeURIComponent(payload.account_id)}/ban${query}${reason}`,
        { method: "POST" },
      )
    } catch (err) {
      if (!isUnimplemented(err)) throw err
      return request<Record<string, unknown>>("/v1/admin/ban", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    }
  }

  /**
   * 管理端：配额调整。
   * 实际后端路径 `POST /v1/admin/accounts/:id/quota`，体 `{delta_tokens, reset}`；
   * 若 404 再回落到契约草案 `POST /v1/admin/quota`。
   */
  async function adminQuota(payload: AdminQuotaRequest): Promise<Record<string, unknown>> {
    const body = { delta_tokens: payload.delta, delta_pct: payload.delta, reset: payload.reset === true, reason: payload.reason }
    try {
      return await request<Record<string, unknown>>(
        `/v1/admin/accounts/${encodeURIComponent(payload.account_id)}/quota`,
        { method: "POST", body: JSON.stringify(body) },
      )
    } catch (err) {
      if (!isUnimplemented(err)) throw err
      return request<Record<string, unknown>>("/v1/admin/quota", {
        method: "POST",
        body: JSON.stringify({ account_id: payload.account_id, ...body }),
      })
    }
  }

  /**
   * 自定义模型配置（POST /api/v1/settings/models，T3.5，已上线）。
   * 后端为复数 `models`；若 404 再尝试任务书里的单数 `model`，两者都 404 → 提示「接口未实现」。
   */
  async function saveModelSettings(payload: ModelSettingsRequest): Promise<Record<string, unknown>> {
    try {
      return await request<Record<string, unknown>>("/v1/settings/models", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    } catch (err) {
      if (!isUnimplemented(err)) throw err
      return request<Record<string, unknown>>("/v1/settings/model", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    }
  }

  /**
   * 本人已保存的自定义模型列表（GET /api/v1/settings/models，T3.5，需 Bearer）。
   * 响应只含元信息（id/name/base_url/model/key_configured/created_at/updated_at），**永不含 key**。
   * 未登录 → 401 {error:"unauthorized"}。
   */
  async function listModels(): Promise<ModelListResponse> {
    return request<ModelListResponse>("/v1/settings/models")
  }

  /**
   * 删除本人的某个自定义模型（DELETE /api/v1/settings/models/:id，T3.5，需 Bearer）。
   * 成功 → `{ok:true, deleted:1}`；越权/不存在 → 404 `{error:"not-found"}`；缺 D1 → 503。
   * id 来自 listModels()，只做 URL 编码，绝不写进日志。
   */
  async function deleteModel(id: string): Promise<ModelDeleteResponse> {
    return request<ModelDeleteResponse>(`/v1/settings/models/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  return {
    search,
    searchStream,
    chat,
    me,
    ackDisclaimer,
    adminUsage,
    adminRatelimit,
    adminAudit,
    adminKeys,
    adminIngestRuns,
    adminBan,
    adminQuota,
    saveModelSettings,
    listModels,
    deleteModel,
    baseURL,
    /** 是否已持有会话 token（模板里做条件渲染用，不暴露 token 本身） */
    hasToken: () => !!readAuthToken(),
  }
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

/** 默认全选四库（供偏好初始化复用） */
export const ALL_CORPUS_IDS: string[] = DEFAULT_CORPORA_OPTIONS.map((c) => c.id)
