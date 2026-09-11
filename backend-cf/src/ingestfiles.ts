// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — "零 chunk 文件集合"读写（技术债 #5：极短文件每轮增量都被复核）
//
// ── 现象（history.md §8.2 第 5 条，2026-09-11 由 ingest_runs 观测到）──
// 一轮手动 ingest 上报：`rle-wiki changed=3 points=0`、`mtf-wiki changed=1 points=0`……
// `files>0` 却 `points=0` —— 这些**极短文件解析后产出 0 个 chunk**（正文为空/只剩 frontmatter）。
// 增量判据是 Qdrant `payload.blob_sha`，而这类文件**没有 point → 没有 payload 可存 sha**
// → 每轮都被判定为"新文件"，重新拉取 + 解析（永远空转，只是不烧 embedding）。
//
// ── 修法：给"没有 payload 的文件"补一条 sha 来源（不新增表）──
// 复用已有的 `ingest_files` 表，用它的新列 `blob_sha` 表达「该 path 在某个 git blob sha 下产出 0 chunk」：
//   · 这一行是 Actions 侧（`scripts/ingest-incremental.ts`）经 `/api/v1/admin/ingest/files` 写的；
//   · 判据仍是 git blob sha（与 Qdrant payload.blob_sha **同一个值**，可直接比较）；
//   · **只有 `blob_sha` 非空的行**属于本集合 → Worker 侧摄取（只写 `content_hash`）的行永远不被误判。
// 下一轮增量：文件在集合里且 sha 未变 → 跳过；sha 变了或不在集合里 → 照旧正常处理。
//
// ── 为什么不让 Actions 直连 D1 ──
// 同 `ingestruns.ts`：Actions **不持有** D1 凭据（多一份高权限密钥要管），由 Worker 代笔。
// 本模块只处理 `path` + git blob sha + 计数，**绝不接受或回显任何密钥**（sha 是 git 对象 id，非敏感）。
//
// ── 与 Qdrant 判据的关系（不变量）──
// Qdrant `payload.blob_sha` 仍是**主判据**：有 payload 的文件一律按它比对。
// 本集合只覆盖"永远不会有 payload"的文件，两条判据在脚本里是**逻辑与**（见 runWiki 的 changed 过滤），
// 因此对已有 payload 的文件行为逐字节不变。

/**
 * 增量"是否需要处理这个文件"的**唯一判据实现**（脚本与单测共用，避免两处逻辑漂移）：
 *   1. `full`（`--full` 强制全量重嵌）→ 一律处理；
 *   2. Qdrant payload 的 `blob_sha` 与当前 git blob sha **相同** → 跳过（**主判据，行为不变**）；
 *   3. 该 path 在"零 chunk 集合"里且 sha 相同 → 跳过（本次新增，只对**没有 payload** 的文件生效）；
 *   4. 其余 → 处理。
 * 注意第 2/3 条是**逻辑与**：有 payload 的文件永远由第 2 条裁决，本集合不会改变它的行为。
 */
export function shouldProcessFile(args: {
  full?: boolean
  /** 当前仓库里该文件的 git blob sha */
  treeSha: string
  /** Qdrant 里已入库的 payload.blob_sha（没有 point / 旧数据无该字段 → undefined） */
  payloadSha?: string
  /** "零 chunk 集合"里记录的 blob_sha（不在集合里 → undefined） */
  zeroChunkSha?: string
}): boolean {
  if (args.full) return true
  if (args.payloadSha === args.treeSha) return false
  return args.zeroChunkSha !== args.treeSha
}

/** 单条零 chunk 文件记录（path + git blob sha）。 */
export interface ZeroChunkFile {
  path: string
  blob_sha: string
}

/** `POST /admin/ingest/files` 的请求体。 */
export interface IngestFilesInput {
  wiki_id?: unknown
  /** 本轮确认"产出 0 chunk"的文件（upsert 进集合） */
  zero_chunk?: unknown
  /** 不再属于集合的 path（本轮产出了 chunk / 文件已从仓库消失）→ 删除 */
  drop?: unknown
}

/** 校验 + 归一后的写入计划。 */
export interface IngestFilesPlan {
  wiki_id: string
  zero_chunk: ZeroChunkFile[]
  drop: string[]
  /** 因非法被丢弃的条目数（返回值回显，便于 Actions 日志发现上游 bug） */
  skipped: number
  /** 是否因超出单次上限而截断（截断只影响"少记几条"，不影响正确性） */
  truncated: boolean
}

export type IngestFilesParseResult = { ok: true; plan: IngestFilesPlan } | { ok: false; error: string }

/** 单次请求最多处理的条目数（zero_chunk + drop 合计）。安全阀，不是正常路径。 */
export const MAX_INGEST_FILES_PER_REQUEST = 2000
/** path 最大长度（repo-root 相对路径）。 */
export const MAX_INGEST_PATH_LEN = 512
/** git blob sha 形状：sha1 = 40 位 hex；放宽到 7~64 位以兼容将来的对象格式。 */
const BLOB_SHA_RE = /^[0-9a-f]{7,64}$/
/** `GET /admin/ingest/files` 最多返回条数（防未知规模撑爆响应）。 */
export const MAX_INGEST_FILES_LIST = 5000
/** `wiki_id` 上限。 */
export const MAX_WIKI_ID_LEN = 64

/**
 * 校验并归一 `POST /admin/ingest/files` 的请求体。
 * 规则：
 *   · `wiki_id` 必填非空 → `wiki_id-required`
 *   · `zero_chunk` / `drop` 若存在必须是数组 → `invalid-body`
 *   · 单条非法（path 非串/空/超长、sha 不像 git sha）→ **跳过该条并计数**（不 422：
 *     一条脏数据不该让整轮上报失败，Actions 侧会打 warning）
 *   · 超出 `MAX_INGEST_FILES_PER_REQUEST` → 截断并标记 `truncated`
 */
export function parseIngestFilesInput(body: unknown): IngestFilesParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "invalid-body" }
  const b = body as IngestFilesInput

  const wikiId = typeof b.wiki_id === "string" ? b.wiki_id.trim() : ""
  if (!wikiId) return { ok: false, error: "wiki_id-required" }
  if (wikiId.length > MAX_WIKI_ID_LEN) return { ok: false, error: "wiki_id-too-long" }
  if (b.zero_chunk !== undefined && !Array.isArray(b.zero_chunk)) return { ok: false, error: "invalid-body" }
  if (b.drop !== undefined && !Array.isArray(b.drop)) return { ok: false, error: "invalid-body" }

  let skipped = 0
  let truncated = false

  const rawZero = (b.zero_chunk as unknown[] | undefined) ?? []
  const zero: ZeroChunkFile[] = []
  const seen = new Set<string>()
  for (const item of rawZero) {
    if (zero.length >= MAX_INGEST_FILES_PER_REQUEST) {
      truncated = true
      break
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      skipped++
      continue
    }
    const rec = item as { path?: unknown; blob_sha?: unknown }
    const path = typeof rec.path === "string" ? rec.path.trim() : ""
    const sha = typeof rec.blob_sha === "string" ? rec.blob_sha.trim().toLowerCase() : ""
    if (!isValidPath(path) || !BLOB_SHA_RE.test(sha)) {
      skipped++
      continue
    }
    if (seen.has(path)) continue // 同请求内重复：保留第一条
    seen.add(path)
    zero.push({ path, blob_sha: sha })
  }

  const budgetLeft = MAX_INGEST_FILES_PER_REQUEST - zero.length
  const rawDrop = (b.drop as unknown[] | undefined) ?? []
  const drop: string[] = []
  const droppedSeen = new Set<string>()
  for (const item of rawDrop) {
    if (drop.length >= budgetLeft) {
      truncated = true
      break
    }
    const path = typeof item === "string" ? item.trim() : ""
    if (!isValidPath(path)) {
      skipped++
      continue
    }
    if (droppedSeen.has(path) || seen.has(path)) continue // 同一 path 不要既写又删
    droppedSeen.add(path)
    drop.push(path)
  }

  return { ok: true, plan: { wiki_id: wikiId, zero_chunk: zero, drop, skipped, truncated } }
}

/** path 归一校验：非空、无控制字符、长度上限（不做 repo 语义校验，wiki_id 已经限定了范围）。 */
export function isValidPath(path: string): boolean {
  if (path === "" || path.length > MAX_INGEST_PATH_LEN) return false
  // 控制字符一律拒绝（含换行/制表）：path 会被写进 D1 并回显在 GET 里，不允许塞入控制字符
  return !/[\u0000-\u001f\u007f]/.test(path)
}

/** 单条 upsert 的 SQL（`ON CONFLICT DO UPDATE` 而非 `INSERT OR REPLACE`）。 */
export const UPSERT_ZERO_CHUNK_SQL =
  `INSERT INTO ingest_files (wiki_id, path, content_hash, blob_sha, updated_at) VALUES (?, ?, '', ?, ?) ` +
  `ON CONFLICT(wiki_id, path) DO UPDATE SET blob_sha = excluded.blob_sha, updated_at = excluded.updated_at`

// 为什么用 ON CONFLICT DO UPDATE 而不是 INSERT OR REPLACE：
// REPLACE 语义是 "DELETE + INSERT"，未列出的列会被重置为默认值 —— 那会把 Worker 侧摄取写的
// `content_hash`（sha1）抹成 ''。ON CONFLICT DO UPDATE 只改 blob_sha/updated_at，两列互不干扰。
// 新行给 `content_hash = ''`：该列 NOT NULL 且无默认值；空串表示"Worker 侧还不知道这个文件的 sha1"
// （Worker 侧跑起来时会按"hash 变了"重新解析一次并写回真值，自愈）。

/**
 * 落地写入计划：先删（drop）再 upsert（zero_chunk）。
 * `drop` 分批（每批一次 `IN (...)`，避免 N 次往返；D1 单语句参数也有上限）。
 * **失败向上抛**：路由回 503，让 Actions 侧看到"这一步没成"（它会软失败，本轮照旧复核）。
 */
export async function applyIngestFilesPlan(db: D1Database, plan: IngestFilesPlan, nowMs: number = Date.now()): Promise<void> {
  for (let i = 0; i < plan.drop.length; i += DROP_BATCH_SIZE) {
    const batch = plan.drop.slice(i, i + DROP_BATCH_SIZE)
    const placeholders = batch.map(() => "?").join(", ")
    await db
      .prepare(`DELETE FROM ingest_files WHERE wiki_id = ? AND path IN (${placeholders})`)
      .bind(plan.wiki_id, ...batch)
      .run()
  }
  for (const f of plan.zero_chunk) {
    await db.prepare(UPSERT_ZERO_CHUNK_SQL).bind(plan.wiki_id, f.path, f.blob_sha, nowMs).run()
  }
}

/** 单条 DELETE 里的 IN 占位符上限（够小，避免触及 D1 参数上限）。 */
export const DROP_BATCH_SIZE = 200

/**
 * 读"零 chunk 集合"（只返回 `blob_sha` 非空的行）。
 * 返回 path → blob_sha 的 Map；`limit+1` 探测是否被截断（`truncated` 供诊断）。
 */
export async function listZeroChunkFiles(
  db: D1Database,
  wikiId: string,
  limit: number = MAX_INGEST_FILES_LIST,
): Promise<{ files: ZeroChunkFile[]; truncated: boolean }> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_INGEST_FILES_LIST)
  const res = await db
    .prepare(
      `SELECT path, blob_sha FROM ingest_files
        WHERE wiki_id = ? AND blob_sha IS NOT NULL AND blob_sha <> ''
        ORDER BY path ASC
        LIMIT ?`,
    )
    .bind(wikiId, capped + 1)
    .all<{ path: unknown; blob_sha: unknown }>()
  const rows = res?.results ?? []
  const truncated = rows.length > capped
  const files: ZeroChunkFile[] = []
  for (const r of rows.slice(0, capped)) {
    const path = typeof r.path === "string" ? r.path : ""
    const sha = typeof r.blob_sha === "string" ? r.blob_sha : ""
    if (path === "" || sha === "") continue
    files.push({ path, blob_sha: sha })
  }
  return { files, truncated }
}
