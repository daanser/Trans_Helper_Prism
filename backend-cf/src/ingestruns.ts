// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — `ingest_runs` 记账读写（技术债清理 #1：让后台看得见摄取历史）
//
// ── 背景（history.md §8.2 第 1 条）──
// 摄取跑在 **GitHub Actions**（`.github/workflows/ingest.yml` → `scripts/ingest-incremental.ts`），
// 那边**没有 D1 绑定**（也不该有：让 Actions 直接握 D1 凭据 = 多一份高权限密钥要管）。
// 于是 `ingest_runs` 从来没被写过 → 后台看不到摄取历史。
// 接法：**由 Worker 代笔** —— Actions 跑完把本次摘要 POST 到 `/api/v1/admin/ingest/runs`（需 ADMIN_API_KEY），
// 本模块负责校验 + 落库；查询走 `GET /api/v1/admin/ingest/runs`。
//
// ── 字段映射（Actions 侧的摘要 → 表列，**故意只有粗粒度**）──
// 表（见 schema.sql）是按 Worker 内摄取设计的细粒度列；Actions 摘要只有 changed/removed/chunks：
//   · `files_changed`    → `files_updated`（"本次变动的文件数"，新增+修改合并，不拆分）
//   · `chunks_upserted`  → `points_upserted`（写入 Qdrant 的 point 数）
//   · 其余列给安全默认（files_added/files_deleted/points_deleted/tokens_used/cost = 0，key_ref = null）
//   · `duration_ms` = `finished_at - started_at`（两者都给了才算，否则 null）
// 这样做的好处：一个端点同时服务 Actions 与将来 Worker 侧的记账（`src/ingest/incremental.ts`
// 的 `recordIngestRun()` 仍按整行写，两者写的是**同一张表**、同一套列语义）。
//
// ── 安全 ──
// 本模块不碰密钥、不读 env、不打印任何东西；`error` 字段落库前截断（500 字符）并压平换行，
// 避免把上游一大段堆栈（可能含 URL/参数）整块塞进 DB。路由鉴权由 `adminAuthorize` 负责。

/** API 接受的运行状态（与 ingest_runs.status 的取值一致）。 */
export const INGEST_RUN_STATUSES = ["success", "failed"] as const
export type IngestRunStatus = (typeof INGEST_RUN_STATUSES)[number]

/** `GET /admin/ingest/runs` 默认条数。 */
export const DEFAULT_INGEST_RUNS_LIMIT = 20
/** 单次最多返回条数（防未知规模撑爆响应）。 */
export const MAX_INGEST_RUNS_LIMIT = 200
/** commit_sha 落库上限（GitHub sha 是 40 位，留余量）。 */
export const MAX_COMMIT_SHA_LEN = 64
/** error 落库上限（截断，避免整段堆栈进 DB）。 */
export const MAX_INGEST_ERROR_LEN = 500
/** wiki_id 上限。 */
export const MAX_WIKI_ID_LEN = 64

/** ingest_runs 的一行（读出来的形状；数值列一律归一为非负整数 / null）。 */
export interface IngestRunRecord {
  id: string
  wiki_id: string
  commit_sha: string
  status: string
  files_added: number
  files_updated: number
  files_deleted: number
  points_upserted: number
  points_deleted: number
  tokens_used: number
  duration_ms: number | null
  error: string | null
  started_at: number
  finished_at: number | null
}

/** `POST /admin/ingest/runs` 的请求体（除 wiki_id/status 外全部可选）。 */
export interface IngestRunInput {
  wiki_id?: unknown
  status?: unknown
  commit_sha?: unknown
  started_at?: unknown
  finished_at?: unknown
  files_changed?: unknown
  chunks_upserted?: unknown
  error?: unknown
}

/** 校验结果：ok=false 时 `error` 是要回的 4xx 代码（不含敏感信息）。 */
export type IngestRunParseResult = { ok: true; run: IngestRunRecord } | { ok: false; error: string }

/** 非负整数（脏/缺失 → fallback；小数截断，负数与 NaN 归 0）。 */
function nonNegInt(v: unknown, fallback = 0): number {
  if (v === undefined || v === null || v === "") return fallback
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.trunc(n))
}

/** 有限非负数字（时间戳用）；非法 → undefined。 */
function timeMs(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.trunc(n)
}

/** 单行文本：trim + 截断 + 压平换行（防把多行堆栈塞进 DB / 日志）。 */
function oneLine(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return ""
  return v.replace(/\s+/g, " ").trim().slice(0, maxLen)
}

/**
 * 校验并归一 `POST /admin/ingest/runs` 的请求体。
 * 规则（对应任务要求"缺字段给安全默认；status 非法 → 422"）：
 *   · `wiki_id` 必填非空（没有安全默认值，缺了就是调用方 bug）→ `wiki_id-required`
 *   · `status` 必须是 `success` | `failed` → `invalid-status`
 *   · 其余字段缺失/非法 → 安全默认（0 / null / now）
 * `nowMs` 由调用方注入（便于单测）；`started_at` 缺省 = `finished_at` ?? now，`finished_at` 缺省 = `started_at`。
 */
export function parseIngestRunInput(body: unknown, nowMs: number = Date.now()): IngestRunParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "invalid-body" }
  const b = body as IngestRunInput

  const wikiId = typeof b.wiki_id === "string" ? b.wiki_id.trim() : ""
  if (!wikiId) return { ok: false, error: "wiki_id-required" }
  if (wikiId.length > MAX_WIKI_ID_LEN) return { ok: false, error: "wiki_id-too-long" }

  const status = typeof b.status === "string" ? b.status.trim() : ""
  if (!(INGEST_RUN_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "invalid-status" }

  const startedAt = timeMs(b.started_at)
  const finishedAtRaw = timeMs(b.finished_at)
  const finishedAt = finishedAtRaw ?? startedAt ?? nowMs
  const started = startedAt ?? finishedAt
  const duration = finishedAt >= started ? finishedAt - started : null

  const errText = oneLine(b.error, MAX_INGEST_ERROR_LEN)

  return {
    ok: true,
    run: {
      id: crypto.randomUUID(),
      wiki_id: wikiId,
      commit_sha: oneLine(b.commit_sha, MAX_COMMIT_SHA_LEN),
      status,
      // Actions 摘要只有"变动文件数 / 写入 point 数"两个粗粒度计数（映射见文件头）
      files_added: 0,
      files_updated: nonNegInt(b.files_changed),
      files_deleted: 0,
      points_upserted: nonNegInt(b.chunks_upserted),
      points_deleted: 0,
      tokens_used: 0,
      duration_ms: duration,
      error: errText === "" ? null : errText,
      started_at: started,
      finished_at: finishedAt,
    },
  }
}

/**
 * 写一行 ingest_runs（列名与 schema.sql 逐字对齐）。
 * 失败向上抛（路由负责回 503）——记账端点的失败必须**可见**，
 * 与 Worker 内摄取（`recordIngestRun` 吞错不阻断摄取）的取舍相反，因为这里除了记账没有别的事要做。
 */
export async function insertIngestRun(db: D1Database, run: IngestRunRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ingest_runs
        (id, wiki_id, commit_sha, status, files_added, files_updated, files_deleted,
         points_upserted, points_deleted, tokens_used, cost, key_ref, duration_ms, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
    )
    .bind(
      run.id,
      run.wiki_id,
      run.commit_sha,
      run.status,
      run.files_added,
      run.files_updated,
      run.files_deleted,
      run.points_upserted,
      run.points_deleted,
      run.tokens_used,
      run.duration_ms,
      run.error,
      run.started_at,
      run.finished_at,
    )
    .run()
}

/** 行 → 记录（脏数据兜底：数值列非数字 → 0，字符串列非串 → ""）。 */
function toRecord(row: Record<string, unknown>): IngestRunRecord {
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = typeof v === "number" ? v : Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    id: str(row.id),
    wiki_id: str(row.wiki_id),
    commit_sha: str(row.commit_sha),
    status: str(row.status),
    files_added: nonNegInt(row.files_added),
    files_updated: nonNegInt(row.files_updated),
    files_deleted: nonNegInt(row.files_deleted),
    points_upserted: nonNegInt(row.points_upserted),
    points_deleted: nonNegInt(row.points_deleted),
    tokens_used: nonNegInt(row.tokens_used),
    duration_ms: numOrNull(row.duration_ms),
    error: typeof row.error === "string" && row.error !== "" ? row.error : null,
    started_at: nonNegInt(row.started_at),
    finished_at: numOrNull(row.finished_at),
  }
}

/**
 * 最近若干条摄取记录，按 `finished_at DESC`（SQLite 里 NULL 最小 → 未完成的排最后）。
 * `limit` 由 `clampIngestRunsLimit()` 夹到 [1, MAX_INGEST_RUNS_LIMIT]。
 */
export async function listIngestRuns(db: D1Database, limit: number = DEFAULT_INGEST_RUNS_LIMIT): Promise<IngestRunRecord[]> {
  const res = await db
    .prepare(
      `SELECT id, wiki_id, commit_sha, status, files_added, files_updated, files_deleted,
              points_upserted, points_deleted, tokens_used, duration_ms, error, started_at, finished_at
         FROM ingest_runs
        ORDER BY finished_at DESC, started_at DESC
        LIMIT ?`,
    )
    .bind(clampIngestRunsLimit(limit))
    .all<Record<string, unknown>>()
  return (res?.results ?? []).map(toRecord)
}

/** `?limit=` 归一：缺失/非法 → 默认 20；夹到 [1, 200]（向下取整）。 */
export function clampIngestRunsLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_INGEST_RUNS_LIMIT
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INGEST_RUNS_LIMIT
  return Math.min(MAX_INGEST_RUNS_LIMIT, Math.floor(n))
}
