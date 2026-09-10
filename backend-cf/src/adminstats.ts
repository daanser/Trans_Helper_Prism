// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf admin 用量总览（tasks.md T3.3 / T3.6「/admin 用量」）
//
// `GET /api/v1/admin/usage` 的数据面：**只读**聚合，真实数据，绝不编造。
//
// ── 数据来源（与 quota.ts 同一口径）──
//   · accounts        → account_id / status / created_at（封禁状态原样透出）
//   · quotas          → `period_start` = window_start、`used_cost` = used_tokens（零 DDL 复用，见 quota.ts 文件头）
//   · 额度/窗口长度   → `limitTokens(env)` / `windowHours(env)`（**唯一**来源，不读 DB 的 monthly_limit）
//   · provider_keys   → `keys[]`（脱敏投影，见 keyadmin.ts）
//
// ── 窗口语义（与 getQuota 一致，纯读不改库）──
// `now - window_start >= window_ms` → 该账号视为**新窗口**（window_start=now、used_tokens=0）。
// 落库推进由 chargeQuota/ensureWindow 负责；管理接口只读，绝不写库。
//
// ── requests / llm_tokens_in / llm_tokens_out 为何是 null ──
// `key_usage` 表**没有 account_id 列**（它按 key 记账，见 schema.sql），因此无法把一次调用归属到账号。
// 与其用 `used_tokens / 200` 之类的反推数字冒充「请求数」（会误导运营、且 rerank/LLM 成本会算错），
// 这里**如实返回 null**（前端 `metric()` 对 null 显示「—」）。key 维度的真实用量在 `keys[]`/`key_usage`。
// 若将来 quota 记账补上「本窗口请求数」，把这三个字段换成真值即可，响应形状不变。
//
// ── 降级 ──
// D1 缺失 → 路由回 503 `{error:"db-unconfigured"}`；SQL 异常 → 向上抛，路由回 503 `{error:"db-unavailable"}`。
// `keys[]` 的失败单独吞掉（返回空数组）：用量总览不该因为 key 表读失败而整体 503。

import { limitTokens, usedPct, windowHours, windowMs } from "./quota"
import { fetchProviderKeyRows, type AdminKeyRow } from "./keyadmin"

/** 单页账号上限（防未知规模撑爆响应）。 */
export const ADMIN_USAGE_ACCOUNT_LIMIT = 500

/** `items[]` 单条账号用量。 */
export interface AdminUsageItem {
  account_id: string
  /** active | banned | disabled（原样透出，前端据此标红） */
  status: string
  created_at: number
  /** 当前窗口起点（epoch ms）；窗口已过期时按「新窗口」= now */
  window_start: number
  used_tokens: number
  limit_tokens: number
  /** 已用百分比（0–100，1 位小数），与 limitTokens(env) 同源 */
  used_pct: number
  /** 剩余百分比（0–100，1 位小数） */
  remaining_pct: number
  exceeded: boolean
  /** 见文件头：key_usage 无 account_id，无法归属 → null（不编造） */
  requests: number | null
  llm_tokens_in: number | null
  llm_tokens_out: number | null
}

/** 全局汇总。`limit_tokens` 是**单账号**额度（= limitTokens(env)），不是 × 账号数。 */
export interface AdminUsageTotal {
  accounts: number
  used_tokens: number
  limit_tokens: number
  window_hours: number
}

/** `GET /admin/usage` 响应体。 */
export interface AdminUsageResponse {
  total: AdminUsageTotal
  items: AdminUsageItem[]
  keys: AdminKeyRow[]
  window: { window_hours: number; limit_tokens: number }
}

/** accounts LEFT JOIN quotas 的行形状。 */
interface UsageDbRow {
  account_id: unknown
  status: unknown
  created_at: unknown
  period_start: unknown
  used_cost: unknown
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

/** 单行 → 视图（与 quota.ts 的 toView 同口径：过期窗口 = 新窗口）。 */
export function toUsageItem(row: UsageDbRow, nowMs: number, env: unknown): AdminUsageItem {
  const limit = limitTokens(env)
  const wms = windowMs(env)
  const rawStart = num(row.period_start, nowMs)
  // 无 quotas 行（LEFT JOIN 出 NULL）→ period_start 兜底 now；窗口起点晚于 now（时钟回拨）也按新窗口处理
  const expired = rawStart > nowMs || nowMs - rawStart >= wms
  const windowStart = expired ? nowMs : rawStart
  const used = expired ? 0 : Math.max(0, num(row.used_cost, 0))
  const pct = usedPct(used, limit)
  return {
    account_id: typeof row.account_id === "string" ? row.account_id : String(row.account_id ?? ""),
    status: typeof row.status === "string" && row.status !== "" ? row.status : "active",
    created_at: num(row.created_at),
    window_start: windowStart,
    used_tokens: used,
    limit_tokens: limit,
    used_pct: pct,
    remaining_pct: clampPct(round1(100 - pct)),
    exceeded: used >= limit,
    requests: null,
    llm_tokens_in: null,
    llm_tokens_out: null,
  }
}

/**
 * 聚合用量总览（真实数据，只读）。
 * 单条 SQL 取 accounts ⟕ quotas（避免 N+1）；keys[] 单独取且失败即降级为空数组。
 * SQL 异常向上抛（路由回 503），绝不返回编造数据。
 */
export async function buildAdminUsage(
  db: D1Database,
  env: unknown = {},
  nowMs: number = Date.now(),
): Promise<AdminUsageResponse> {
  const limit = limitTokens(env)
  const hours = windowHours(env)

  const res = await db
    .prepare(
      `SELECT a.id AS account_id, a.status AS status, a.created_at AS created_at,
              q.period_start AS period_start, q.used_cost AS used_cost
         FROM accounts a
    LEFT JOIN quotas q ON q.account_id = a.id
        ORDER BY a.created_at DESC, a.id ASC
        LIMIT ?`,
    )
    .bind(ADMIN_USAGE_ACCOUNT_LIMIT)
    .all<UsageDbRow>()

  const items = (res?.results ?? [])
    .map((row) => toUsageItem(row, nowMs, env))
    .filter((item) => item.account_id !== "")

  let keys: AdminKeyRow[] = []
  try {
    keys = await fetchProviderKeyRows(db)
  } catch {
    // key 表读失败不拖垮用量总览（keys[] 留空，页面其余部分照常显示）
    keys = []
  }

  const usedTotal = items.reduce((sum, it) => sum + it.used_tokens, 0)
  return {
    total: { accounts: items.length, used_tokens: usedTotal, limit_tokens: limit, window_hours: hours },
    items,
    keys,
    window: { window_hours: hours, limit_tokens: limit },
  }
}
