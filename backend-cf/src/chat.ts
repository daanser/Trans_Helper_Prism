// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 多轮追问会话（plan.md §8.3 第 2 条 / §8.4，tasks.md T3.4）
//
// 定位：基于 D1 `chat_sessions` 表（schema.sql 已存在，本文件不改 schema）承载 LLM 追问的上下文：
//   - 创建会话：存 `initial_hits`（首轮 hits 锚点 JSON）与 `corpora`（本次选中的库）；
//   - 追加轮次：`history` JSON 存最近 N 条消息，**最多 10 轮**（user 轮计数），超长逐条截断；
//   - 读取上下文：loadContext 给 LLM provider 组装 messages（配合 llm.ts 的 buildPrompt）。
// 约束：
//   - 缺 D1 绑定时**优雅降级**：createSession→null、loadContext→null、appendRound→{ok:false}，绝不抛错；
//   - `history`/`initial_hits` 一律 JSON.stringify 落库、读取时安全解析（脏数据当空数组，不炸请求）；
//   - 单条消息与初始 hit 均截断（§8.4 prompt 长度控制），绝不把无限长上下文写库。
// 隐私：只存会话内容与命中锚点，不存任何 key；session_id 由 randomUUID 生成，不含用户身份信息。

import { selectHits, truncateText, type ChatMessage, type LlmHit } from "./llm"

/** 一个会话最多多少轮（user 提问计一轮，§8.4 第 4 条）。 */
export const CHAT_MAX_ROUNDS = 10
/** history 里最多保留的消息条数（10 轮 ≈ 10 问 10 答）。 */
export const CHAT_MAX_HISTORY_MESSAGES = 20
/** 单条消息最大字符数（超出截断）。 */
export const CHAT_MAX_MESSAGE_CHARS = 4_000
/** history 中的一条消息。 */
export interface ChatRound {
  role: "user" | "assistant"
  content: string
  /** epoch ms */
  at: number
}

/** 会话上下文（对外只暴露解析后的结构，不暴露原始 JSON 列）。 */
export interface ChatContext {
  id: string
  accountId: string
  modelId: string
  corpora: string[]
  /** 已发生的 user 轮次 */
  roundCount: number
  /** 首轮 hits（作为上下文锚点，序号与 `[来源n]` 对应） */
  initialHits: LlmHit[]
  history: ChatRound[]
  createdAt: number
  updatedAt: number
}

/** D1 预处理语句的最小形状（真实 D1PreparedStatement 结构兼容）。 */
export interface ChatStmt {
  bind(...values: unknown[]): ChatStmt
  first<T = unknown>(): Promise<T | null>
  run(): Promise<unknown>
}

/** D1 绑定的最小形状（真实 D1Database 结构兼容，便于单测 mock）。 */
export interface ChatDb {
  prepare(sql: string): ChatStmt
}

/** 可空 DB（缺 D1 时优雅降级）。 */
export type MaybeChatDb = ChatDb | null | undefined

/** appendRound 的结果：`ok:false` 时调用方按 reason 决定提示文案。 */
export type AppendRoundResult =
  | { ok: true; context: ChatContext; truncated: boolean }
  | { ok: false; reason: "db-unavailable" | "session-not-found" | "max-rounds" | "invalid-round" }

/** chat_sessions 原始行形状。 */
interface ChatSessionRow {
  id: string
  account_id: string
  model_id: string
  corpora: string
  round_count: number
  initial_hits: string
  history: string
  created_at: number
  updated_at: number
}

/** 安全解析 JSON 数组（脏数据/缺省 → 空数组，绝不抛错）。 */
function safeParseArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

/** 生成会话 id（workerd 与 Node 均有 crypto.randomUUID）。 */
function newSessionId(): string {
  return crypto.randomUUID()
}

/** 行 → ChatContext（解析 JSON 列）。 */
function rowToContext(row: ChatSessionRow): ChatContext {
  const hits = safeParseArray<LlmHit>(row.initial_hits).map((h) => ({
    id: h?.id,
    title: h?.title,
    url: h?.url,
    source: h?.source,
    text: typeof h?.text === "string" ? h.text : "",
  }))
  const history = safeParseArray<ChatRound>(row.history)
    .filter((r) => r && (r.role === "user" || r.role === "assistant") && typeof r.content === "string")
    .map((r) => ({ role: r.role, content: r.content, at: typeof r.at === "number" ? r.at : 0 }))
  return {
    id: row.id,
    accountId: row.account_id,
    modelId: row.model_id,
    corpora: safeParseArray<string>(row.corpora).filter((c) => typeof c === "string"),
    roundCount: typeof row.round_count === "number" ? row.round_count : 0,
    initialHits: hits,
    history,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 创建会话：把首轮 hits（截断到 LLM_MAX_HITS/条）与 corpora 落库。
 * 缺 D1 或缺 accountId 时返回 null（调用方按无会话处理，仍可单轮总结）。
 */
export async function createSession(
  db: MaybeChatDb,
  accountId: string,
  modelId: string,
  corpora: readonly string[],
  hits: readonly LlmHit[],
  nowMs: number,
): Promise<ChatContext | null> {
  if (!db) return null
  if (!accountId) return null

  const { hits: kept } = selectHits(hits)
  const context: ChatContext = {
    id: newSessionId(),
    accountId,
    modelId: modelId || "default",
    corpora: [...(corpora ?? [])],
    roundCount: 0,
    initialHits: kept,
    history: [],
    createdAt: nowMs,
    updatedAt: nowMs,
  }

  try {
    await db
      .prepare(
        "INSERT INTO chat_sessions (id, account_id, model_id, corpora, round_count, initial_hits, history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        context.id,
        context.accountId,
        context.modelId,
        JSON.stringify(context.corpora),
        context.roundCount,
        JSON.stringify(context.initialHits),
        JSON.stringify(context.history),
        context.createdAt,
        context.updatedAt,
      )
      .run()
    return context
  } catch {
    // 落库失败不阻断本次请求（会话退化为无记忆）
    return null
  }
}

/** 读取会话上下文。缺 D1 / 会话不存在 / 脏数据 → null。 */
export async function loadContext(db: MaybeChatDb, sessionId: string): Promise<ChatContext | null> {
  if (!db || !sessionId) return null
  try {
    const row = await db
      .prepare(
        "SELECT id, account_id, model_id, corpora, round_count, initial_hits, history, created_at, updated_at FROM chat_sessions WHERE id = ?",
      )
      .bind(sessionId)
      .first<ChatSessionRow>()
    if (!row) return null
    return rowToContext(row)
  } catch {
    return null
  }
}

/**
 * 追加一条消息。
 * - role="user" 计一轮；已达 CHAT_MAX_ROUNDS 返回 `{ok:false, reason:"max-rounds"}`（前端提示开新会话）；
 * - role="assistant" 只入库不计数；
 * - history 超长丢弃最旧消息（truncated=true），单条内容超长截断。
 */
export async function appendRound(
  db: MaybeChatDb,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  nowMs: number,
): Promise<AppendRoundResult> {
  if (!db) return { ok: false, reason: "db-unavailable" }
  if (!sessionId) return { ok: false, reason: "session-not-found" }
  if (role !== "user" && role !== "assistant") return { ok: false, reason: "invalid-round" }
  const text = (content ?? "").trim()
  if (!text) return { ok: false, reason: "invalid-round" }

  const ctx = await loadContext(db, sessionId)
  if (!ctx) return { ok: false, reason: "session-not-found" }

  if (role === "user" && ctx.roundCount >= CHAT_MAX_ROUNDS) {
    return { ok: false, reason: "max-rounds" }
  }

  const nextHistory: ChatRound[] = [
    ...ctx.history,
    { role, content: truncateText(text, CHAT_MAX_MESSAGE_CHARS), at: nowMs },
  ]
  const overflow = Math.max(0, nextHistory.length - CHAT_MAX_HISTORY_MESSAGES)
  const history = overflow > 0 ? nextHistory.slice(overflow) : nextHistory
  const roundCount = ctx.roundCount + (role === "user" ? 1 : 0)

  try {
    await db
      .prepare("UPDATE chat_sessions SET round_count = ?, history = ?, updated_at = ? WHERE id = ?")
      .bind(roundCount, JSON.stringify(history), nowMs, sessionId)
      .run()
  } catch {
    return { ok: false, reason: "db-unavailable" }
  }

  return {
    ok: true,
    truncated: overflow > 0,
    context: { ...ctx, roundCount, history, updatedAt: nowMs },
  }
}

/**
 * history → LLM messages（去掉 at 字段，按原顺序）。
 * 配合 llm.ts 的 `buildPrompt(hits, question, history)` 使用：history 只保留最近 N 条。
 */
export function historyToMessages(history: readonly ChatRound[]): ChatMessage[] {
  return (history ?? [])
    .filter((r) => r && typeof r.content === "string" && r.content.trim() !== "")
    .slice(-CHAT_MAX_HISTORY_MESSAGES)
    .map((r) => ({ role: r.role, content: r.content }))
}

/** 会话是否已达轮次上限（前端据此提示"开新会话"）。 */
export function isMaxRounds(ctx: ChatContext | null): boolean {
  return !!ctx && ctx.roundCount >= CHAT_MAX_ROUNDS
}
