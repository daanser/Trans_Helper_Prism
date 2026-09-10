// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf admin 用量总览（tasks.md T3.3 / T3.6「/admin 用量」）
//
// `GET /api/v1/admin/usage` 的数据面：**只读**聚合，真实数据，绝不编造。
//
// ── 数据来源（与 quota.ts 同一口径）──
//   · accounts        → account_id / status / created_at（封禁状态原样透出）
//   · quotas          → `period_start` = window_start、`used_cost` = used_tokens、`requests` = 本窗口真实请求数
//   · key_usage       → `account_id` 维度的窗口内用量（llm_tokens_in / llm_tokens_out）
//   · 额度/窗口长度   → `limitTokens(env)` / `windowHours(env)`（**唯一**来源，不读 DB 的 monthly_limit）
//   · provider_keys   → `keys[]`（脱敏投影，见 keyadmin.ts）
//
// ── 窗口语义（与 getQuota 一致，纯读不改库）──
// `now - window_start >= window_ms`（或 period_start 缺失/来自未来）→ 该账号视为**新窗口**
// （window_start=now、used_tokens=0、窗口内用量计数 0）。落库推进由 chargeQuota/ensureWindow 负责；
// 管理接口只读，绝不写库。
//
// ── requests / llm_tokens_in / llm_tokens_out 的口径（2026-09-11 技术债 #4 改口径）──
//   · requests        = **真实用户请求数**：`quotas.requests`（本窗口内扣费成功的请求数，
//                       由 chargeQuota 与 used_cost 在同一条原子 UPDATE 里 +1）。
//       ⚠️ 口径：**只有扣费成功的请求**计入 —— 额度耗尽后走关键词回退、或零消耗（回退/免费）的请求
//          不扣费、因而不 +1；窗口切换时由 ensureWindow 清零。它**不再**是"上游调用行数"。
//   · llm_tokens_in   = 该账号窗口内 **endpoint='chat'** 的 tokens_in 之和（embed/rerank 计 0）
//   · llm_tokens_out  = 同上，tokens_out 之和
// 这两个 token 数仍来自 `key_usage`（每账号一行一次模型调用；`account_id` 由
// `makeKeyUsageDb(env, accountId)` 写入，匿名 = 空串）。无数据 = 0（不是 null）。
// **匿名调用（account_id=''）不归属任何账号**，不计入 items（仍留在 key_usage）。
// 历史口径（老 `requests`）保留在 `aggregateKeyUsage()` 里：那是 key_usage 行数
// （含换 key 重试的失败行），即"上游调用次数"。`AdminUsageItem.upstream_calls` 会把它透出，
// 便于看"重试放大"；`requests` 则回答"这个账号到底点了多少次"。
// 窗口过滤在 JS 里按每个账号自己的 window_start 做（唯一真值来源 = resolveWindowStart），
// SQL 只做「窗口并集 + 排除匿名」的粗筛，避免 N+1 也避免多读无谓的行。
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
  /** 见文件头口径：该账号当前窗口内**扣费成功**的真实请求数（`quotas.requests`；无数据 = 0） */
  requests: number
  /**
   * 老口径（保留可观测性）：该账号窗口内的 `key_usage` 行数 = 上游模型调用次数
   * （含换 key 重试产生的失败行）。与 `requests` 之差 ≈ 重试/失败放大。
   */
  upstream_calls: number
  /** 该账号窗口内 endpoint='chat' 的 tokens_in 之和（embed/rerank 计 0，无数据 = 0） */
  llm_tokens_in: number
  /** 同上，tokens_out 之和 */
  llm_tokens_out: number
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
  /** `quotas.requests`（旧库未迁移该列时查询会退化，见 buildAdminUsage） */
  requests: unknown
}

/** key_usage 窗口粗筛行形状（只取聚合需要的列）。 */
export interface KeyUsageRow {
  account_id: unknown
  endpoint: unknown
  tokens_in: unknown
  tokens_out: unknown
  created_at: unknown
}

/** 单账号窗口内用量聚合结果。 */
export interface AccountUsageAgg {
  requests: number
  llm_tokens_in: number
  llm_tokens_out: number
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 非负整数（脏数据兜底：负数/小数/NaN 一律夹到 0 或取整）。 */
function nonNegInt(v: unknown): number {
  return Math.max(0, Math.trunc(num(v, 0)))
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

/** 账号 id 归一（DB 里是 TEXT；null/undefined → 空串，空串账号在 items 里被过滤掉）。 */
function accountIdOf(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "")
}

/** 该账号的窗口是否已过期/无效（无 quotas 行、超过 window_ms、或起点来自未来 = 时钟回拨）。 */
function windowExpired(periodStartRaw: unknown, nowMs: number, env: unknown): boolean {
  const raw = num(periodStartRaw, nowMs)
  return raw > nowMs || nowMs - raw >= windowMs(env)
}

/**
 * 当前窗口起点（epoch ms）——**窗口语义的唯一实现**：
 * period_start 缺失（无 quotas 行）、已过期（now - start ≥ window_ms）或来自未来（时钟回拨）→ now（新窗口）。
 * 与 quota.ts 的 toView 同口径；`toUsageItem()` 与 key_usage 聚合都用它，保证二者窗口完全一致。
 */
export function resolveWindowStart(periodStartRaw: unknown, nowMs: number, env: unknown = {}): number {
  return windowExpired(periodStartRaw, nowMs, env) ? nowMs : num(periodStartRaw, nowMs)
}

/**
 * 把 key_usage 行按账号聚合：**只计窗口内**（每账号用自己的 window_start，上限 now）的行；
 * 只有 `endpoint === 'chat'` 累加 token（embed/rerank 的 token 记 0）。
 * 匿名行（account_id='')、以及不在 windowStarts 里的账号（已删除 / 超出 items 上限）一律忽略。
 * 纯函数，零 IO：单测直接喂 mock 行即可覆盖窗口与 endpoint 口径。
 */
export function aggregateKeyUsage(
  rows: readonly KeyUsageRow[],
  windowStarts: ReadonlyMap<string, number>,
  nowMs: number,
): Map<string, AccountUsageAgg> {
  const out = new Map<string, AccountUsageAgg>()
  for (const row of rows) {
    const accountId = accountIdOf(row.account_id)
    if (accountId === "") continue // 匿名调用不归属任何账号
    const windowStart = windowStarts.get(accountId)
    if (windowStart === undefined) continue // 不在本次账号清单内
    const createdAt = num(row.created_at, Number.NaN)
    // 窗口 = [window_start, now]（window_start 过期时 = now，故窗口自然为空）
    if (!Number.isFinite(createdAt) || createdAt < windowStart || createdAt > nowMs) continue
    const cur = out.get(accountId) ?? { requests: 0, llm_tokens_in: 0, llm_tokens_out: 0 }
    cur.requests += 1
    if (row.endpoint === "chat") {
      cur.llm_tokens_in += nonNegInt(row.tokens_in)
      cur.llm_tokens_out += nonNegInt(row.tokens_out)
    }
    out.set(accountId, cur)
  }
  return out
}

/** 单行 → 视图（与 quota.ts 的 toView 同口径：过期窗口 = 新窗口）。`usage` 缺省 = 该账号窗口内无用量（全 0）。 */
export function toUsageItem(
  row: UsageDbRow,
  nowMs: number,
  env: unknown,
  usage?: AccountUsageAgg | null,
): AdminUsageItem {
  const limit = limitTokens(env)
  const windowStart = resolveWindowStart(row.period_start, nowMs, env)
  const expired = windowExpired(row.period_start, nowMs, env)
  const used = expired ? 0 : Math.max(0, num(row.used_cost, 0))
  // 窗口过期 = 新窗口：used_cost 与 requests 都按 0 呈现（与 quota.ts 的 toView 同口径；
  // 落库清零由 ensureWindow 负责，这里只读不改库）。
  const requests = expired ? 0 : nonNegInt(row.requests)
  const pct = usedPct(used, limit)
  return {
    account_id: accountIdOf(row.account_id),
    status: typeof row.status === "string" && row.status !== "" ? row.status : "active",
    created_at: num(row.created_at),
    window_start: windowStart,
    used_tokens: used,
    limit_tokens: limit,
    used_pct: pct,
    remaining_pct: clampPct(round1(100 - pct)),
    exceeded: used >= limit,
    requests,
    upstream_calls: nonNegInt(usage?.requests),
    llm_tokens_in: nonNegInt(usage?.llm_tokens_in),
    llm_tokens_out: nonNegInt(usage?.llm_tokens_out),
  }
}

/**
 * 读窗口并集内的 key_usage 行（**一条 SQL**，不做每账号一查的 N+1）。
 * 粗筛：`account_id <> ''`（匿名不归属账号）+ `created_at ∈ [最早窗口起点, now]`；
 * 精确的每账号窗口过滤交给 `aggregateKeyUsage()`（唯一窗口真值来源）。
 * 账号数为 0 时直接不发查询。
 *
 * 不加 LIMIT 是**故意的**：截断会静默少算（宁可慢一点，也不要假的数字）。
 * 读放大由「滚动窗口（默认 5h）+ 限流」天然约束；若将来 key_usage 体量变大，可改成
 * `GROUP BY account_id, endpoint` 的 SQL 聚合（会把窗口/ endpoint 口径搬进 SQL，代价是单测只能断言 SQL 形状）。
 */
async function fetchAccountUsage(
  db: D1Database,
  windowStarts: ReadonlyMap<string, number>,
  nowMs: number,
): Promise<Map<string, AccountUsageAgg>> {
  if (windowStarts.size === 0) return new Map()
  let earliest = nowMs
  for (const start of windowStarts.values()) if (start < earliest) earliest = start

  const res = await db
    .prepare(
      `SELECT account_id AS account_id, endpoint AS endpoint,
              tokens_in AS tokens_in, tokens_out AS tokens_out, created_at AS created_at
         FROM key_usage
        WHERE account_id <> '' AND created_at >= ? AND created_at <= ?`,
    )
    .bind(earliest, nowMs)
    .all<KeyUsageRow>()

  return aggregateKeyUsage(res?.results ?? [], windowStarts, nowMs)
}

/**
 * 聚合用量总览（真实数据，只读）。
 * 单条 SQL 取 accounts ⟕ quotas（避免 N+1），另加**一条** key_usage 窗口粗筛聚合（同样无 N+1）；
 * keys[] 单独取且失败即降级为空数组。SQL 异常向上抛（路由回 503），绝不返回编造数据。
 *
 * `quotas.requests`（技术债 #4）来自同一条 JOIN，零额外查询；旧库未迁移该列时退化为旧查询
 * （`NULL AS requests` → items[].requests = 0），见下方 try/catch 的说明。
 */
export async function buildAdminUsage(
  db: D1Database,
  env: unknown = {},
  nowMs: number = Date.now(),
): Promise<AdminUsageResponse> {
  const limit = limitTokens(env)
  const hours = windowHours(env)

  // `quotas.requests` 由 SCHEMA_MIGRATIONS 补列。若部署后还没跑 apply-schema（旧库没有该列），
  // 带 requests 的查询会报 `no such column` —— 那时**退化为旧查询**（requests 记 0），
  // 保证整个管理面板不会因为少一列而 503；迁移完成后自动恢复真值。
  // 注意：真正的 DB 故障（库不可用）会让退化查询同样失败 → 继续向上抛 → 路由回 503，不会被吞掉。
  const selectAccounts = (withRequests: boolean) =>
    db
      .prepare(
        withRequests
          ? `SELECT a.id AS account_id, a.status AS status, a.created_at AS created_at,
                    q.period_start AS period_start, q.used_cost AS used_cost, q.requests AS requests
               FROM accounts a
          LEFT JOIN quotas q ON q.account_id = a.id
              ORDER BY a.created_at DESC, a.id ASC
              LIMIT ?`
          : `SELECT a.id AS account_id, a.status AS status, a.created_at AS created_at,
                    q.period_start AS period_start, q.used_cost AS used_cost, NULL AS requests
               FROM accounts a
          LEFT JOIN quotas q ON q.account_id = a.id
              ORDER BY a.created_at DESC, a.id ASC
              LIMIT ?`,
      )
      .bind(ADMIN_USAGE_ACCOUNT_LIMIT)
      .all<UsageDbRow>()

  let res: Awaited<ReturnType<typeof selectAccounts>>
  try {
    res = await selectAccounts(true)
  } catch {
    res = await selectAccounts(false)
  }

  const rows = res?.results ?? []

  // 账号 → 当前窗口起点（与 toUsageItem 同一函数，保证窗口口径完全一致）
  const windowStarts = new Map<string, number>()
  for (const row of rows) {
    const id = accountIdOf(row.account_id)
    if (id === "") continue
    windowStarts.set(id, resolveWindowStart(row.period_start, nowMs, env))
  }
  const usage = await fetchAccountUsage(db, windowStarts, nowMs)

  const items = rows
    .map((row) => {
      const id = accountIdOf(row.account_id)
      return toUsageItem(row, nowMs, env, usage.get(id) ?? null)
    })
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
