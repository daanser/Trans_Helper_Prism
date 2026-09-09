// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 审计日志（tasks.md T3.3 / schema.sql `audit_log`）
//
// 用途：敏感操作留痕（封禁/解封、加额/扣额、改模型配置、key 上架禁用……），
// 验收口径「审计表可查谁何时封了谁」（tasks.md T3.3）。
//
// ── 隐私/密钥底线 ──
// detail **只接受泛化文本**（如 "reason=abuse-frequency"、"delta=+3600s"）。
// 本模块再做两层兜底（defense in depth）：
//   1. `redactSecrets()`：把 `sk-…` / `Bearer …` / `key=…|token=…|secret=…` 之类形状抹成 `[redacted]`；
//   2. 长度截断：detail ≤ 200 字、target ≤ 128 字、action ≤ 64 字，且空白折叠成单行。
// 调用方仍**必须**保证不传 key 明文/用户隐私（key 引用名用 provider_keys.key_ref，不用真 key）。
//
// ── 降级 ──
// D1 缺失 → 静默跳过（返回 false，不抛错）；SQL 异常 → 吞掉并返回 false，
// **绝不阻断主流程**（封禁/加额该成功就成功，审计只是旁路）。
// D1Database 类型由 tsconfig 的 `types: ["@cloudflare/workers-types"]` 全局注入（与 auth.ts 一致）。

/** detail 最大长度（字符）。 */
export const AUDIT_DETAIL_MAX = 200
/** target 最大长度（字符）。 */
export const AUDIT_TARGET_MAX = 128
/** action 最大长度（字符）。 */
export const AUDIT_ACTION_MAX = 64

/** 审计写入输入。 */
export interface AuditInput {
  /** 操作者 account_id；空/缺省记为 "system"（schema 中 NOT NULL） */
  actorId: string
  /** 动作：ban | unban | grant_quota | revoke_quota | set_model | key_enable | key_disable | ... */
  action: string
  /** 被操作对象：account_id / key_ref / model_id（**不得**放 key 明文） */
  target?: string
  /** 泛化说明（脱敏，不含 key/隐私）；会被 redact + 截断 */
  detail?: string
  /** 事件时间（epoch ms），缺省 Date.now() */
  nowMs?: number
}

/** 审计行（listAudit 返回）。 */
export interface AuditRow {
  id: string
  actor_id: string
  action: string
  target: string
  detail: string
  created_at: number
}

/** D1 绑定（允许 undefined/null 以便静默跳过）。 */
export type AuditDb = D1Database | null | undefined

/** 密钥形状的模式（顺序即优先级；只抹已知 secret 形状，不误伤普通文本）。 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // 硅基流动/OpenAI 风格 key：sk-xxxx
  [/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]"],
  // Authorization: Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, "Bearer [redacted]"],
  // key=… / api_key: … / token=… / secret=… / password=…（保留原分隔符，只抹值）
  [
    /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)\b\s*([=:]\s*)[^\s,;]+/gi,
    "$1$2[redacted]",
  ],
]

/** 抹掉已知密钥形状（纯函数，便于单测）。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement)
  }
  return out
}

/**
 * 规范化审计文本：redact → 空白折叠成单行 → 去首尾 → 截断到 max 字。
 * 非字符串/空 → ""。
 */
export function sanitizeAuditText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return ""
  const redacted = redactSecrets(raw).replace(/\s+/g, " ").trim()
  if (max <= 0) return ""
  return redacted.length > max ? redacted.slice(0, max) : redacted
}

/** detail 规范化（对外暴露，便于调用方预校验/单测）。 */
export function sanitizeAuditDetail(raw: unknown, max: number = AUDIT_DETAIL_MAX): string {
  return sanitizeAuditText(raw, max)
}

/**
 * 写一条审计记录。
 * @returns true = 已写入；false = D1 缺失或写入失败（静默，不抛错）
 */
export async function writeAudit(db: AuditDb, input: AuditInput): Promise<boolean> {
  if (!db) return false
  const actorId = sanitizeAuditText(input.actorId, AUDIT_TARGET_MAX) || "system"
  const action = sanitizeAuditText(input.action, AUDIT_ACTION_MAX)
  if (!action) return false // 无动作的审计没有意义，直接跳过（不抛错）
  const target = sanitizeAuditText(input.target, AUDIT_TARGET_MAX)
  const detail = sanitizeAuditDetail(input.detail)
  const nowMs = typeof input.nowMs === "number" && Number.isFinite(input.nowMs) ? input.nowMs : Date.now()
  const id = crypto.randomUUID()

  try {
    await db
      .prepare("INSERT INTO audit_log (id, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, actorId, action, target, detail, nowMs)
      .run()
    return true
  } catch (e) {
    // 旁路失败不阻断主流程；日志只打泛化信息（不含 detail/参数，避免泄密）。
    console.warn(`[audit] write failed action=${action}: ${(e as Error)?.name ?? "error"}`)
    return false
  }
}

/** listAudit 选项。 */
export interface ListAuditOptions {
  /** 单页条数，默认 50，夹到 [1, 200] */
  limit?: number
  /** 偏移，默认 0 */
  offset?: number
}

/**
 * 按时间倒序查审计（同一毫秒用 id 倒序兜底，保证稳定分页）。
 * D1 缺失/异常 → []（不抛错）。
 */
export async function listAudit(db: AuditDb, options: ListAuditOptions = {}): Promise<AuditRow[]> {
  if (!db) return []
  const rawLimit = options.limit ?? 50
  const rawOffset = options.offset ?? 0
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  try {
    const res = await db
      .prepare(
        "SELECT id, actor_id, action, target, detail, created_at FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      )
      .bind(limit, offset)
      .all<AuditRow>()
    return res?.results ?? []
  } catch (e) {
    console.warn(`[audit] list failed: ${(e as Error)?.name ?? "error"}`)
    return []
  }
}
