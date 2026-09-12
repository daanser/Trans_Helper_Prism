// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf LLM provider（plan.md §8.1/§8.3/§8.4，tasks.md T3.4）
//
// 定位：Workers 服务端统一代理硅基流动中国站 chat/completions（OpenAI 兼容）。前端永不直连、永不碰 key。
// 关键设计：
//   - 所有 key 走 Key Pool 的 **llm 能力**（合并池：`POOL_KEYS_<n>`，见 plan-keypool.md）；401/403/429/402/5xx/超时自动换 key 重试一次
//     （复用 keypool.withKeyRetry）；池全灭/超时 → 抛可识别 `LLMError`，调用方降级为纯搜索 + `AI总结暂不可用`。
//   - 默认模型 `Qwen/Qwen3.5-4B`（§8.1 实测 0.42s），可被 `LLM_MODEL` 覆盖；端点可被 `LLM_ENDPOINT` 覆盖。
//   - `max_tokens` 上限 800（§8.4 成本控制）；超时 `LLM_TIMEOUT_MS`（默认 20s）；支持 `stream: true` SSE。
//   - 防胡说硬约束（§8.3 第 1 条）：system prompt 强制"只依据给定片段、逐条标 [来源n]、片段没有就说不知道、不得编造"。
//   - prompt 截断（§8.4）：每条 hit ≤ 600 字、最多 6 条（常量导出，便于单测与调参）。
//   - 每 key 用量记账（§8.5）：endpoint="chat"、pool="llm"，写入 D1 key_usage（由注入的 KeyPoolDb 完成）。
// 安全：错误信息只含泛化状态码与上游文案（已脱敏），绝不回显 key。

import {
  KeyPool,
  withKeyRetry,
  type KeyPoolDb,
  type PoolKey,
  type ResponseLike,
} from "./keypool"
import { defaultFetch, estimateTokens } from "./embeddings"

// ─────────────────────────────────────────────
// 常量（可调项集中在此，单测直接断言）
// ─────────────────────────────────────────────

/** 默认模型（plan.md §8.1 T0.0 实测锁定）。 */
export const LLM_DEFAULT_MODEL = "Qwen/Qwen3.5-4B"
/** 默认端点（硅基流动中国站，OpenAI 兼容）。 */
export const LLM_DEFAULT_ENDPOINT = "https://api.siliconflow.cn/v1/chat/completions"
/** 单次上游调用硬超时（毫秒，env `LLM_TIMEOUT_MS` 可覆盖）。 */
export const LLM_DEFAULT_TIMEOUT_MS = 20_000
/** 输出 token 上限（§8.4 成本控制）。 */
export const LLM_MAX_TOKENS = 800
/** 单次总结最多塞入的 hit 条数（§8.4）。 */
export const LLM_MAX_HITS = 6
/** 每条 hit 正文最大字符数（§8.4）。 */
export const LLM_HIT_MAX_CHARS = 600
/** 用户问题最大字符数（防超长 prompt 烧钱）。 */
export const LLM_QUESTION_MAX_CHARS = 1_000
/** 多轮追问最多保留的历史消息条数（§8.4：最多 10 轮 ≈ 10 问 10 答）。 */
export const LLM_MAX_HISTORY_MESSAGES = 20
/** 池全灭时的降级提示文案（§8.1/§8.5）。 */
export const LLM_UNAVAILABLE_NOTICE = "AI总结暂不可用"

/**
 * system prompt：防胡说硬约束。改这里前先读 plan.md §8.3 第 1 条与 tasks.md T3.4 验收
 * （"有引用且引用 id 全部可点击回跳 hits"）——引用格式必须是 `[来源n]`。
 */
export const LLM_SYSTEM_PROMPT = [
  "你是 TransHelper Prism 的检索助手，服务中文性别/性少数 wiki 的检索结果答疑。",
  "你必须严格遵守以下硬性规则，任何情况下都不得违反：",
  "1. 只依据下面给出的检索片段（【片段1】…【片段n】）回答，不得使用片段之外的知识。",
  "2. 不得推测、不得编造、不得补充片段中没有的事实、数字、链接或文献。",
  "3. 每一条结论后面必须标注来源编号，格式为 [来源1]、[来源2]；多个来源写 [来源1][来源3]。",
  "4. 如果片段中没有足够信息回答问题，必须直接回答「根据现有片段无法回答」或「不知道」，不要强行作答。",
  "5. 用简体中文、分点、简洁作答；不要复述本段规则，也不要提及「片段」之外的内容。",
].join("\n")

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

/** 一条检索命中（只取总结需要的字段；与 types.ts 的 SearchHit 结构兼容）。 */
export interface LlmHit {
  /** 命中 id（可选，用于前端回跳定位） */
  id?: string
  title?: string
  url?: string
  text: string
  /** 来源库名（如 mtf-wiki） */
  source?: string
}

/** OpenAI 兼容消息。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** 引用锚点：前端据 index 渲染 `[来源n]` 并回跳到对应 hit。 */
export interface CitationRef {
  /** 1-based，与 prompt 里的【片段n】/[来源n] 一一对应 */
  index: number
  /** 展示标签，如 "来源1" */
  label: string
  title: string
  url?: string
  id?: string
}

/** buildPrompt 的纯函数产物（便于单测断言，不触发任何网络）。 */
export interface PromptBuild {
  system: string
  /** 完整消息序列（含 system 与历史轮次） */
  messages: ChatMessage[]
  citations: CitationRef[]
  /** 实际塞入的 hit 条数（≤ LLM_MAX_HITS） */
  usedHits: number
  /** 因超过 LLM_MAX_HITS 被丢弃的 hit 条数 */
  droppedHits: number
  /** 因超过 LLM_HIT_MAX_CHARS 被截断的 hit 条数 */
  truncatedHits: number
}

/**
 * token 用量（配额扣减用，T3.2 对接）。
 * `estimated=true` 表示上游没回 `usage` 字段，这里按字符数估算（CJK 加权，见 estimateTokens）。
 */
export interface LlmUsage {
  tokens_in: number
  tokens_out: number
  estimated: boolean
}

/** 非流式补全结果（含真实/估算 token 用量）。 */
export interface LlmCompletion {
  text: string
  model: string
  tokens_in: number
  tokens_out: number
  /** true = 上游未返回 usage，tokens_* 为估算值 */
  estimated: boolean
  latencyMs: number
}

/** 总结结果（含引用锚点 + token 用量）。 */
export interface LlmSummary {
  text: string
  citations: CitationRef[]
  model: string
  tokens_in: number
  tokens_out: number
  estimated: boolean
  latencyMs: number
}

/** 流式结果：`for await (const delta of stream)` 逐块拿增量文本。 */
export interface LlmStream extends AsyncIterable<string> {
  /** 本次总结的引用锚点（prompt 构造时即确定，可先返回给前端） */
  readonly citations: CitationRef[]
  readonly model: string
  /**
   * 流结束（或中断）后 resolve 的 token 用量；流失败时 reject 同一个 LLMError。
   * 上游流式响应默认不带 usage，故通常是 `estimated: true`（按累计字符数估算）。
   * 调用方用它扣配额（T3.2）：`const u = await llm.usage`。
   */
  readonly usage: Promise<LlmUsage>
}

/** 调用选项。 */
export interface LlmCallOptions {
  /** 覆盖默认 max_tokens（上限仍由上游约束，这里只做本地钳制） */
  maxTokens?: number
  /** 覆盖超时（毫秒） */
  timeoutMs?: number
  /** 多轮历史（最近 N 条，超出由 buildPrompt 截断） */
  history?: ChatMessage[]
}

/** 可识别错误码：调用方按码降级，不必解析文案。 */
export type LlmErrorCode =
  /** 池全灭 / 未配置任何 POOL_KEYS_<n>：整体降级为纯搜索 + LLM_UNAVAILABLE_NOTICE */
  | "llm-unavailable"
  /** 上游超时（含流式空闲超时） */
  | "llm-timeout"
  /** 上游返回错误（非可换 key 错误码，或换 key 后仍失败） */
  | "llm-upstream"
  /** 上游返回空内容 */
  | "llm-empty"
  /** 本地配置错误（端点/模型非法） */
  | "llm-config"

/** LLM 侧可识别错误。`degrade=true` 表示调用方应降级为纯搜索，不得 500。 */
export class LLMError extends Error {
  readonly code: LlmErrorCode
  readonly status?: number
  readonly degrade = true
  constructor(code: LlmErrorCode, message: string, status?: number) {
    super(message)
    this.name = "LLMError"
    this.code = code
    this.status = status
  }
}

/** 判断是否属于"LLM 不可用，降级即可"的错误。 */
export function isLlmUnavailable(e: unknown): e is LLMError {
  return e instanceof LLMError
}

/** 上游/异常文案脱敏：抹掉一切疑似 key 的串（错误信息绝不回显 key）。 */
export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text
  for (const s of extraSecrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]")
  }
  // 常见 key 形态：sk-xxx / Bearer xxx / 长 base64 串
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1[redacted]")
  return out.slice(0, 300)
}

/**
 * 把 keypool / fetch 的异常映射为可识别 LLMError。
 * keypool 的两种"无可用 key"要区分（否则会把上游 500 误判成池全灭）：
 *   - `…无可用 key`：池本来就是空的 → llm-unavailable（未配置/全被剔除）；
 *   - `…换 key 后仍无可用 key（首错 status=5xx / AbortError）`：上游先出错 → 按首错归类。
 */
export function classifyLlmError(e: unknown, secrets: readonly string[] = []): LLMError {
  if (e instanceof LLMError) return e
  const msg = (e as Error)?.message ?? String(e)
  const name = (e as Error)?.name ?? ""

  if (/无可用 key/.test(msg)) {
    const firstStatus = /首错\s*status=(\d+)/.exec(msg)
    if (firstStatus) {
      return new LLMError("llm-upstream", `llm-upstream status=${firstStatus[1]}`, parseInt(firstStatus[1], 10))
    }
    if (/首错\s*AbortError|首错\s*Error:.*abort/i.test(msg)) {
      return new LLMError("llm-timeout", `llm-timeout: ${redactSecrets(msg, secrets)}`)
    }
    return new LLMError("llm-unavailable", "llm-pool-exhausted")
  }
  if (name === "AbortError" || /abort|timeout|timed out/i.test(msg)) {
    return new LLMError("llm-timeout", `llm-timeout: ${redactSecrets(msg, secrets)}`)
  }
  return new LLMError("llm-upstream", `llm-upstream: ${redactSecrets(msg, secrets)}`)
}

// ─────────────────────────────────────────────
// 纯函数：prompt 构造与截断
// ─────────────────────────────────────────────

/** 按字符数截断（不抛错；保留省略号便于前端识别）。 */
export function truncateText(text: string, max: number): string {
  const s = (text ?? "").trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + "…"
}

/** 取前 LLM_MAX_HITS 条 hit 并逐条截断，返回用于 prompt 的片段。 */
export function selectHits(hits: readonly LlmHit[]): {
  hits: LlmHit[]
  droppedHits: number
  truncatedHits: number
} {
  const usable = (hits ?? []).filter((h) => h && typeof h.text === "string" && h.text.trim() !== "")
  const kept = usable.slice(0, LLM_MAX_HITS)
  let truncatedHits = 0
  const out = kept.map((h) => {
    const text = h.text.trim()
    if (text.length > LLM_HIT_MAX_CHARS) truncatedHits++
    return { ...h, text: truncateText(text, LLM_HIT_MAX_CHARS) }
  })
  return { hits: out, droppedHits: Math.max(0, usable.length - kept.length), truncatedHits }
}

/**
 * 构造总结/追问的 prompt（纯函数，无网络、无副作用）。
 * - hits 截断：每条 ≤ LLM_HIT_MAX_CHARS、最多 LLM_MAX_HITS 条；
 * - 编号即 `[来源n]` 的 n，与 citations 一一对应（前端回跳用）；
 * - history 只保留最近 LLM_MAX_HISTORY_MESSAGES 条（§8.4 最多 10 轮）。
 */
export function buildPrompt(
  hits: readonly LlmHit[],
  question: string,
  history: readonly ChatMessage[] = [],
): PromptBuild {
  const { hits: kept, droppedHits, truncatedHits } = selectHits(hits)

  const citations: CitationRef[] = kept.map((h, i) => ({
    index: i + 1,
    label: `来源${i + 1}`,
    title: (h.title ?? "").trim() || `片段${i + 1}`,
    url: h.url,
    id: h.id,
  }))

  const fragmentLines: string[] = []
  kept.forEach((h, i) => {
    const n = i + 1
    const head = [`【片段${n}】`, h.title ? `标题：${h.title.trim()}` : "", h.source ? `来源库：${h.source}` : "", h.url ? `链接：${h.url}` : ""]
      .filter(Boolean)
      .join(" ")
    fragmentLines.push(`${head}\n正文：${h.text}`)
  })

  const contextBlock =
    kept.length > 0
      ? `检索片段如下（共 ${kept.length} 条，引用时写 [来源1]…[来源${kept.length}]）：\n\n${fragmentLines.join("\n\n")}`
      : "本次没有任何检索片段可用。按硬性规则第 4 条，直接回答「根据现有片段无法回答」。"

  const userContent = `${contextBlock}\n\n【用户问题】\n${truncateText(question, LLM_QUESTION_MAX_CHARS)}`

  const historyTail = (history ?? [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim() !== "")
    .slice(-LLM_MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: truncateText(m.content, LLM_HIT_MAX_CHARS * 4) }))

  const messages: ChatMessage[] = [
    { role: "system", content: LLM_SYSTEM_PROMPT },
    ...historyTail,
    { role: "user", content: userContent },
  ]

  return {
    system: LLM_SYSTEM_PROMPT,
    messages,
    citations,
    usedHits: kept.length,
    droppedHits,
    truncatedHits,
  }
}

/** 从模型输出里抽出引用的来源编号（单测断言"每条结论都带 [来源n]"用）。 */
export function extractCitationIndices(text: string): number[] {
  const out: number[] = []
  const re = /\[来源\s*(\d+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text ?? "")) !== null) {
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && !out.includes(n)) out.push(n)
  }
  return out
}

// ─────────────────────────────────────────────
// SSE 解析（流式输出）
// ─────────────────────────────────────────────

/** 一个 SSE 事件（`data:` 行拼接后的载荷）。 */
export interface SseEvent {
  event?: string
  data: string
}

/**
 * 增量解析 SSE 文本块：返回已完成的事件与未完成的尾巴（跨 chunk 拼接用）。
 * 兼容 `\n\n` / `\r\n\r\n` 分隔、`data:` 多行、注释行（`:` 开头）与 `event:` 行。
 */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  const normalized = buffer.replace(/\r\n/g, "\n")
  const parts = normalized.split("\n\n")
  const rest = parts.pop() ?? ""
  for (const block of parts) {
    if (!block.trim()) continue
    let eventName: string | undefined
    const dataLines: string[] = []
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue
      const colon = line.indexOf(":")
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? "" : line.slice(colon + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "data") dataLines.push(value)
      else if (field === "event") eventName = value
    }
    if (dataLines.length === 0 && eventName === undefined) continue
    events.push({ event: eventName, data: dataLines.join("\n") })
  }
  return { events, rest }
}

/** 从单个 SSE 事件的 data 载荷里抽增量文本（OpenAI 兼容 `choices[].delta.content`）。 */
export function extractDeltaContent(data: string): string {
  if (!data || data === "[DONE]") return ""
  try {
    const j = JSON.parse(data) as {
      choices?: { delta?: { content?: string | null }; message?: { content?: string | null } }[]
    }
    const c = j.choices?.[0]
    return c?.delta?.content ?? c?.message?.content ?? ""
  } catch {
    return ""
  }
}

/**
 * 逐事件迭代 SSE 响应体。`onChunk` 在每次收到原始字节后回调（流式空闲超时重置用）。
 * 非流式/无 body 时抛 LLMError，由调用方降级。
 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        onChunk?.()
        buffer += decoder.decode(value, { stream: true })
      }
      const { events, rest } = parseSseChunk(buffer)
      buffer = rest
      for (const ev of events) yield ev
    }
    buffer += decoder.decode()
    const { events } = parseSseChunk(buffer + "\n\n")
    for (const ev of events) yield ev
  } finally {
    // 上游中断/超时时尽力取消，避免连接悬挂
    await reader.cancel().catch(() => undefined)
  }
}

// ─────────────────────────────────────────────
// provider 实现
// ─────────────────────────────────────────────

/** LLM 提供方的最小契约（§8.5 逃生通道：换供应商只换实现）。 */
export interface ChatProvider {
  /** 非流式总结（带引用锚点）。失败抛 LLMError。 */
  summarize(hits: readonly LlmHit[], question: string, opts?: LlmCallOptions): Promise<LlmSummary>
  /** 流式总结（SSE）。失败抛 LLMError。 */
  streamSummary(hits: readonly LlmHit[], question: string, opts?: LlmCallOptions): LlmStream
  /** 直接发消息（多轮追问用；调用方自行构造 messages，建议先过 buildPrompt）。 */
  chat(messages: readonly ChatMessage[], opts?: LlmCallOptions): Promise<LlmCompletion>
  readonly model: string
}

/** 上游 chat/completions 响应形状（OpenAI 兼容）。 */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** 上游调用结果（ResponseLike 给 withKeyRetry 判定，raw 给流式读取 body）。 */
interface UpstreamCall {
  like: ResponseLike
  raw?: Response
}

/** 硅基流动中国站 chat 实现。 */
export class SiliconFlowChat implements ChatProvider {
  readonly model: string
  private readonly endpoint: string
  private readonly pool: KeyPool
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxTokens: number
  /** undefined = 请求体不带 `enable_thinking` 字段（部分非 Qwen 模型不接受该参数）。 */
  private readonly enableThinking: boolean | undefined

  constructor(
    cfg: {
      model: string
      endpoint?: string
      timeoutMs?: number
      maxTokens?: number
      enableThinking?: boolean | undefined
    },
    pool: KeyPool,
    fetchImpl: typeof fetch = defaultFetch,
  ) {
    this.model = cfg.model
    this.endpoint = (cfg.endpoint ?? LLM_DEFAULT_ENDPOINT).replace(/\/+$/, "")
    this.timeoutMs = cfg.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS
    this.maxTokens = cfg.maxTokens ?? LLM_MAX_TOKENS
    this.enableThinking = cfg.enableThinking
    this.pool = pool
    this.fetchImpl = fetchImpl
  }

  /** 对单个 key 发起一次上游调用。超时/网络错误抛错，交给 withKeyRetry 换 key。 */
  private async callUpstream(
    key: PoolKey,
    messages: readonly ChatMessage[],
    stream: boolean,
    opts: LlmCallOptions,
    controller: AbortController,
  ): Promise<UpstreamCall> {
    const resp = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key.secret}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: Math.min(opts.maxTokens ?? this.maxTokens, this.maxTokens),
        stream,
        // 关思考链：Qwen3.5-4B 走非推理路径，省 token 省延迟（§8.4）。
        // undefined（env LLM_ENABLE_THINKING=omit）时整个字段不发送，兼容不接受该参数的模型。
        ...(this.enableThinking === undefined ? {} : { enable_thinking: this.enableThinking }),
      }),
    })
    return {
      like: {
        ok: resp.ok,
        status: resp.status,
        json: () => resp.json(),
        text: () => resp.text(),
      },
      raw: resp,
    }
  }

  /** 记账（失败不阻断业务）。 */
  private record(
    keyRef: string,
    status: "ok" | "failed",
    statusCode: number | undefined,
    latencyMs: number,
    usage?: LlmUsage,
  ): Promise<void> {
    return this.pool.recordUsage({
      pool: "llm",
      keyRef,
      endpoint: "chat",
      model: this.model,
      status,
      statusCode,
      tokensIn: usage?.tokens_in,
      tokensOut: usage?.tokens_out,
      latencyMs,
    })
  }

  async chat(messages: readonly ChatMessage[], opts: LlmCallOptions = {}): Promise<LlmCompletion> {
    const started = Date.now()
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs
    /** 本次调用用过的 key 明文（仅用于脱敏，绝不出参、绝不落库）。 */
    const secrets: string[] = []
    let keyRef = "unknown"
    let statusCode: number | undefined

    let resp: ResponseLike
    try {
      resp = await withKeyRetry(this.pool, "llm", async (key) => {
        keyRef = key.ref
        secrets.push(key.secret)
        // 每次尝试都新建 controller：换 key 重试时旧 controller 已 abort，复用会立刻失败/挂死。
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const call = await this.callUpstream(key, messages, false, opts, controller)
          statusCode = call.like.status
          if (!call.like.ok) {
            // 上游失败也按 key 记账（§8.5：哪个号烧/挂了要能看见）
            await this.record(key.ref, "failed", call.like.status, Date.now() - started)
          }
          return call.like
        } finally {
          clearTimeout(timer)
        }
      })
    } catch (e) {
      throw classifyLlmError(e, secrets)
    }

    if (!resp.ok) {
      const detail = (await resp.text?.().catch(() => "")) ?? ""
      throw new LLMError(
        "llm-upstream",
        `llm-upstream status=${resp.status} detail=${redactSecrets(detail, secrets)}`,
        resp.status,
      )
    }

    const data = (await (resp.json ? resp.json() : Promise.resolve(undefined))) as ChatCompletionResponse | undefined
    const text = (data?.choices?.[0]?.message?.content ?? "").trim()
    // 用量：优先上游 usage；缺失则按字符数估算并标 estimated（配额侧要知道可信度）。
    const usage: LlmUsage = data?.usage
      ? {
          tokens_in: data.usage.prompt_tokens ?? 0,
          tokens_out: data.usage.completion_tokens ?? 0,
          estimated: false,
        }
      : {
          tokens_in: estimateTokens(messages.map((m) => m.content)),
          tokens_out: estimateTokens([text]),
          estimated: true,
        }
    if (!text) {
      await this.record(keyRef, "failed", statusCode, Date.now() - started, usage)
      throw new LLMError("llm-empty", "llm-empty-response")
    }
    await this.record(keyRef, "ok", statusCode, Date.now() - started, usage)
    return {
      text,
      model: this.model,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      estimated: usage.estimated,
      latencyMs: Date.now() - started,
    }
  }

  async summarize(hits: readonly LlmHit[], question: string, opts: LlmCallOptions = {}): Promise<LlmSummary> {
    const built = buildPrompt(hits, question, opts.history)
    const out = await this.chat(built.messages, opts)
    return {
      text: out.text,
      citations: built.citations,
      model: out.model,
      tokens_in: out.tokens_in,
      tokens_out: out.tokens_out,
      estimated: out.estimated,
      latencyMs: out.latencyMs,
    }
  }

  streamSummary(hits: readonly LlmHit[], question: string, opts: LlmCallOptions = {}): LlmStream {
    const built = buildPrompt(hits, question, opts.history)
    const pool = this.pool
    const model = this.model
    const defaultTimeout = this.timeoutMs
    // 生成器是普通函数，this 会丢；显式捕获实例引用。
    const self = this

    // 用量在流结束时结算：上游流式响应默认不带 usage，故按累计字符数估算（estimated=true）。
    let settleUsage!: (u: LlmUsage) => void
    let failUsage!: (e: unknown) => void
    const usagePromise = new Promise<LlmUsage>((resolve, reject) => {
      settleUsage = resolve
      failUsage = reject
    })
    // 调用方可能只 for-await 而从不 await usage：挂一个空 catch，避免 unhandled rejection。
    usagePromise.catch(() => undefined)

    const promptTokensIn = () => estimateTokens(built.messages.map((m) => m.content))

    const record = (
      keyRef: string,
      status: "ok" | "failed",
      statusCode: number | undefined,
      latencyMs: number,
      usage?: LlmUsage,
    ) =>
      pool.recordUsage({
        pool: "llm",
        keyRef,
        endpoint: "chat",
        model,
        status,
        statusCode,
        tokensIn: usage?.tokens_in,
        tokensOut: usage?.tokens_out,
        latencyMs,
      })

    /** 把 keypool / fetch 的异常映射为可识别 LLMError（与 chat 同规则）。 */
    const mapStreamError = (e: unknown, secrets: readonly string[] = []): LLMError => classifyLlmError(e, secrets)

    async function* generate(): AsyncGenerator<string> {
      const timeoutMs = opts.timeoutMs ?? defaultTimeout
      const controller = new AbortController()
      // 流式用"空闲超时"：每收到一块就重置，避免长答案被整体超时砍断。
      let timer = setTimeout(() => controller.abort(), timeoutMs)
      const bump = () => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), timeoutMs)
      }
      const started = Date.now()
      /** 本次流用过的 key 明文（仅脱敏用）。 */
      const secrets: string[] = []
      let keyRef = "unknown"
      let statusCode: number | undefined
      let acc = ""
      let settled = false
      const finish = (u: LlmUsage) => {
        if (settled) return
        settled = true
        settleUsage(u)
      }
      const fail = (e: unknown) => {
        if (settled) return
        settled = true
        failUsage(e)
      }
      const usageSoFar = (): LlmUsage => ({
        tokens_in: promptTokensIn(),
        tokens_out: estimateTokens([acc]),
        estimated: true,
      })

      try {
        let resp: ResponseLike
        let raw: Response | undefined
        try {
          resp = await withKeyRetry(pool, "llm", async (key) => {
            keyRef = key.ref
            secrets.push(key.secret)
            // this 通过箭头函数捕获，避免在生成器里丢绑定（workerd 下 fetch/this 都会炸）。
            const call = await self.callUpstream(key, built.messages, true, opts, controller)
            statusCode = call.like.status
            raw = call.raw
            if (!call.like.ok) await record(key.ref, "failed", call.like.status, Date.now() - started)
            return call.like
          })
        } catch (e) {
          throw mapStreamError(e, secrets)
        }

        if (!resp.ok) {
          const detail = (await resp.text?.().catch(() => "")) ?? ""
          throw new LLMError(
            "llm-upstream",
            `llm-upstream status=${resp.status} detail=${redactSecrets(detail, secrets)}`,
            resp.status,
          )
        }
        if (!raw?.body) {
          const usage = usageSoFar()
          await record(keyRef, "failed", statusCode, Date.now() - started, usage)
          throw new LLMError("llm-empty", "llm-stream-no-body")
        }

        let emitted = 0
        for await (const ev of iterateSse(raw.body, bump)) {
          if (ev.data === "[DONE]") break
          const delta = extractDeltaContent(ev.data)
          if (delta) {
            acc += delta
            emitted += delta.length
            yield delta
          }
        }
        const usage = usageSoFar()
        await record(keyRef, emitted > 0 ? "ok" : "failed", statusCode, Date.now() - started, usage)
        if (emitted === 0) throw new LLMError("llm-empty", "llm-empty-stream")
        finish(usage)
      } catch (e) {
        fail(e)
        throw e
      } finally {
        clearTimeout(timer)
        // 消费者提前 break / 上游中断：也把已累计的用量结算出去，配额侧不会漏记。
        finish(usageSoFar())
      }
    }

    return {
      citations: built.citations,
      model: this.model,
      usage: usagePromise,
      [Symbol.asyncIterator]: () => generate(),
    }
  }
}

// ─────────────────────────────────────────────
// 工厂与便捷入口
// ─────────────────────────────────────────────

/**
 * env 中 LLM 相关字段（见交付报告的"新增 env 变量"）。
 * 说明：`types.ts` 的 `Env` 目前**还没声明**这些字段，而 TS 会对"全可选属性"的类型做弱类型检查
 * （无公共属性即报错），所以工厂参数先收 `unknown` 再内部收窄——这样 `createChatProvider(c.env, db)`
 * 今天就能编译。等 captain 把字段补进 `Env` 后，可把签名收紧成 `env: LlmEnv` 并获得补全。
 */
export interface LlmEnv {
  // 密钥不再逐项声明：来自 `POOL_KEYS_<n>`（动态前缀扫描，见 keypool.ts 的 parseMergedKeys）。
  LLM_MODEL?: string
  LLM_ENDPOINT?: string
  LLM_TIMEOUT_MS?: string
  LLM_MAX_TOKENS?: string
  /** "false"（默认）关闭思考链；"true" 打开；"omit" 完全不发送该字段（兼容非 Qwen 模型）。 */
  LLM_ENABLE_THINKING?: string
}

/** 把 `c.env`（或任意 env 形状）收窄成 LlmEnv；缺字段一律走默认值。 */
export function asLlmEnv(env: unknown): LlmEnv {
  return (env ?? {}) as LlmEnv
}

/** 解析 enable_thinking 三态（false / true / omit）。 */
function parseThinkingFlag(raw: string | undefined): boolean | undefined {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "omit") return undefined
  if (v === "true" || v === "1" || v === "on") return true
  return false
}

/** 解析正整数 env（缺省/非法回落）。 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 用 env 构造 KeyPool（llm 池）后实例化 chat provider 的工厂（与 createEmbeddingProvider 同风格）。
 * 注意：KeyPool 的冷却/剔除是**内存态**，生产建议在 index.ts 复用单例（见交付报告"接线片段"），
 * 否则每次请求新建池会丢掉跨请求的 key 冷却信息。
 */
export function createChatProvider(
  env: unknown,
  db: KeyPoolDb,
  fetchImpl: typeof fetch = defaultFetch,
): { pool: KeyPool; provider: ChatProvider } {
  const e = asLlmEnv(env)
  const pool = new KeyPool(e, db)
  const provider = new SiliconFlowChat(
    {
      model: e.LLM_MODEL?.trim() || LLM_DEFAULT_MODEL,
      endpoint: e.LLM_ENDPOINT,
      timeoutMs: parsePositiveInt(e.LLM_TIMEOUT_MS, LLM_DEFAULT_TIMEOUT_MS),
      maxTokens: Math.min(parsePositiveInt(e.LLM_MAX_TOKENS, LLM_MAX_TOKENS), LLM_MAX_TOKENS),
      enableThinking: parseThinkingFlag(e.LLM_ENABLE_THINKING),
    },
    pool,
    fetchImpl,
  )
  return { pool, provider }
}

/**
 * 一次性总结（便捷入口，内部新建 provider/pool）。
 * 失败抛 LLMError；调用方应 `catch (e) { if (isLlmUnavailable(e)) → 纯搜索结果 + LLM_UNAVAILABLE_NOTICE }`。
 */
export async function summarize(
  env: unknown,
  db: KeyPoolDb,
  hits: readonly LlmHit[],
  question: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<LlmSummary> {
  const { provider } = createChatProvider(env, db, fetchImpl)
  return provider.summarize(hits, question)
}

/**
 * 一次性流式总结（便捷入口）。返回 AsyncIterable<string>；池全灭/超时在**迭代时**抛 LLMError，
 * 调用方需在 SSE 循环里 catch 并推一条降级事件（见报告接线片段）。
 */
export function streamSummary(
  env: unknown,
  db: KeyPoolDb,
  hits: readonly LlmHit[],
  question: string,
  fetchImpl: typeof fetch = defaultFetch,
): LlmStream {
  const { provider } = createChatProvider(env, db, fetchImpl)
  return provider.streamSummary(hits, question)
}
