// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 用量汇总（M4-W3 月账的原料）
//
// ── 为什么需要它 ──
// `key_usage` 每行记录一次上游调用（endpoint/status/tokens/latency），但我们**没有任何查询入口** ——
// 于是"这个月打了多少次 embedding / rerank / chat、用了多少 token"根本看不到，月账无从下手。
// 本模块把它聚合出来；**单价由人填**（硅基流动/CF 的账单口径在各自控制台），我们只负责如实报量。
//
// ── 只读 + 不新增写入 ──
// 全部是聚合 SELECT，不写任何表、不占配额、不限流（与 `/admin/*` 同级）。
// ⚠️ `key_usage` 目前只有 `(key_ref, created_at)` 索引，按 `created_at` 过滤会走全表扫描；
//    当前量级（万行级）无感，若将来行数上万再补 `created_at` 索引（走 SCHEMA_MIGRATIONS）。

/** 单次查询的最大回溯天数（防止有人传 99999 拉全表）。 */
export const USAGE_MAX_DAYS = 365
/** 默认回溯天数（一个自然月）。 */
export const USAGE_DEFAULT_DAYS = 30

/** 可空 D1（缺绑定时优雅降级）。 */
export type UsageDb = D1Database | null | undefined

export interface UsageEndpointRow {
  endpoint: string
  calls: number
  ok: number
  failed: number
  tokens_in: number
  tokens_out: number
  avg_latency_ms: number | null
}

export interface UsageDayRow {
  day: string
  calls: number
  tokens_in: number
  tokens_out: number
}

export interface UsageSummary {
  days: number
  since: number
  until: number
  by_endpoint: UsageEndpointRow[]
  by_day: UsageDayRow[]
  totals: { calls: number; tokens_in: number; tokens_out: number; failed: number }
  quota_window: { accounts: number; used_tokens: number; limit_tokens: number }
  ingest: { runs: number; failed: number; points_upserted: number; last_success_at: number | null }
}

/** 解析 `?days=`：非法/缺失回默认，超上限夹取。 */
export function parseUsageDays(raw: string | undefined, fallback: number = USAGE_DEFAULT_DAYS): number {
  const n = Number.parseInt(String(raw ?? ""), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, USAGE_MAX_DAYS)
}

/** D1 返回的聚合行（列名即 SQL 别名）。 */
interface EndpointAggRow {
  endpoint: string
  calls: number
  ok: number
  failed: number
  tokens_in: number
  tokens_out: number
  avg_latency_ms: number | null
}
interface DayAggRow {
  day: string
  calls: number
  tokens_in: number
  tokens_out: number
}
interface QuotaAggRow {
  accounts: number
  used_tokens: number
}
interface IngestAggRow {
  runs: number
  failed: number
  points_upserted: number
  last_success_at: number | null
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0)

/** 把聚合行整形为响应（纯函数，便于单测）。 */
export function shapeUsageSummary(args: {
  days: number
  since: number
  until: number
  endpoints: EndpointAggRow[]
  days_rows: DayAggRow[]
  quota: QuotaAggRow | null
  ingest: IngestAggRow | null
  limitTokens: number
}): UsageSummary {
  const by_endpoint: UsageEndpointRow[] = (args.endpoints ?? []).map((r) => ({
    endpoint: String(r.endpoint ?? ""),
    calls: num(r.calls),
    ok: num(r.ok),
    failed: num(r.failed),
    tokens_in: num(r.tokens_in),
    tokens_out: num(r.tokens_out),
    avg_latency_ms: r.avg_latency_ms === null || r.avg_latency_ms === undefined ? null : Math.round(num(r.avg_latency_ms)),
  }))
  const by_day: UsageDayRow[] = (args.days_rows ?? []).map((r) => ({
    day: String(r.day ?? ""),
    calls: num(r.calls),
    tokens_in: num(r.tokens_in),
    tokens_out: num(r.tokens_out),
  }))
  const totals = by_endpoint.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      tokens_in: acc.tokens_in + r.tokens_in,
      tokens_out: acc.tokens_out + r.tokens_out,
      failed: acc.failed + r.failed,
    }),
    { calls: 0, tokens_in: 0, tokens_out: 0, failed: 0 },
  )
  return {
    days: args.days,
    since: args.since,
    until: args.until,
    by_endpoint,
    by_day,
    totals,
    quota_window: {
      accounts: num(args.quota?.accounts),
      used_tokens: num(args.quota?.used_tokens),
      limit_tokens: args.limitTokens,
    },
    ingest: {
      runs: num(args.ingest?.runs),
      failed: num(args.ingest?.failed),
      points_upserted: num(args.ingest?.points_upserted),
      last_success_at: args.ingest?.last_success_at ?? null,
    },
  }
}

/**
 * 聚合最近 N 天的上游用量。缺 D1 / 读失败 → 抛错（由路由映射 503）；
 * 路由是管理员只读诊断，**不该假装成功**（与 fail-open 的检索路径不同）。
 */
export async function fetchUsageSummary(
  db: UsageDb,
  opts: { days: number; nowMs: number; limitTokens: number },
): Promise<UsageSummary> {
  if (!db) throw new Error("db-unconfigured")
  const since = opts.nowMs - opts.days * 24 * 3600 * 1000

  const endpoints = await db
    .prepare(
      `SELECT endpoint,
              COUNT(*) AS calls,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(tokens_in) AS tokens_in,
              SUM(tokens_out) AS tokens_out,
              AVG(latency_ms) AS avg_latency_ms
         FROM key_usage
        WHERE created_at >= ?
        GROUP BY endpoint
        ORDER BY calls DESC`,
    )
    .bind(since)
    .all<EndpointAggRow>()

  const dayRows = await db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS calls,
              SUM(tokens_in) AS tokens_in,
              SUM(tokens_out) AS tokens_out
         FROM key_usage
        WHERE created_at >= ?
        GROUP BY day
        ORDER BY day`,
    )
    .bind(since)
    .all<DayAggRow>()

  const quota = await db
    .prepare("SELECT COUNT(*) AS accounts, SUM(used_cost) AS used_tokens FROM quotas")
    .first<QuotaAggRow>()

  const ingest = await db
    .prepare(
      `SELECT COUNT(*) AS runs,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(points_upserted) AS points_upserted,
              MAX(CASE WHEN status = 'success' THEN finished_at END) AS last_success_at
         FROM ingest_runs
        WHERE started_at >= ?`,
    )
    .bind(since)
    .first<IngestAggRow>()

  return shapeUsageSummary({
    days: opts.days,
    since,
    until: opts.nowMs,
    endpoints: endpoints?.results ?? [],
    days_rows: dayRows?.results ?? [],
    quota: quota ?? null,
    ingest: ingest ?? null,
    limitTokens: opts.limitTokens,
  })
}
