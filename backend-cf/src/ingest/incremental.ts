// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 每日增量管线 (tasks.md T2.2 / plan.md §7.3)
// 流程：Cron(UTC 01:00) → 每 wiki 发 Queue 消息 → 本模块 ingestWiki：
//   拉 tarball → 定位 content_dir → 只收 .md → 对比 D1 上次成功 commit sha（相同则 skip，0 拉包）
//   → 按 ingest_files 表的内容 hash 做文件级 diff：只对 新增/修改 的文件 解析/embed/upsert，
//     对消失的文件删 Qdrant points → 更新 ingest_files → 写 D1 ingest_runs（记账）。
// 真·增量（M2 真增量版）：hash 相同不重嵌（省 embedding token）；无 ingest_files 表时退化全量重嵌（幂等覆盖）。
// 单 wiki 失败不影响其它 wiki（Queue 天然隔离）；本模块全部可注入 fetchImpl/nowMs，便于单测。
// Serverless 兼容：hash 用 WebCrypto crypto.subtle（workerd 原生），不依赖 node:crypto。
import { createEmbeddingProvider } from "../embeddings"
import { getWiki } from "../wiki_registry"
import { buildSiteUrl } from "../wikiUrl"
import {
  downloadTarball,
  extractTarGz,
  stripTopDir,
  resolveContentDir,
  fetchCommitSha,
  collectMarkdown,
} from "./github"
import {
  parseFrontmatter,
  cleanBody,
  buildDirMeta,
  resolvePathMeta,
  chunkMarkdownWithText,
  pointId,
  type ChunkRecord,
} from "./parser"
import type { Env } from "../types"
import type { KeyPoolDb } from "../keypool"

/** Queue 消息形状：每 wiki 一条。 */
export interface IngestMessage {
  wikiId: string
}

/** ingest 一次的结果摘要（写 ingest_runs 用 + 日志/单测断言）。 */
export interface IngestResult {
  wiki_id: string
  commit_sha: string
  status: "success" | "skipped" | "error"
  files_added: number
  files_updated: number
  files_deleted: number
  points_upserted: number
  points_deleted: number
  tokens_used: number
  duration_ms: number
  error?: string
}

/** 无 D1 记账时的空实现（测试/无 DB 环境）。 */
const noopDb: KeyPoolDb = { async recordUsage() {} }

/** Qdrant 集合名（与 search.ts 一致：横杠→下划线 + _v1）。 */
function collName(wikiId: string): string {
  return `${wikiId.replace(/-/g, "_")}_v1`
}

/** 读该 wiki 最近一次成功 ingest 的 commit sha；无则空串。DB 缺失/异常 → 空串。 */
export async function lastIngestedCommitSha(db: D1Database | undefined, wikiId: string): Promise<string> {
  if (!db) return ""
  try {
    const res = await db
      .prepare("SELECT commit_sha FROM ingest_runs WHERE wiki_id = ? AND status = 'success' ORDER BY finished_at DESC LIMIT 1")
      .bind(wikiId)
      .first<{ commit_sha: string | null }>()
    return res?.commit_sha ?? ""
  } catch {
    return ""
  }
}

/** 文件内容 hash（workerd 原生 WebCrypto，无 node:crypto 依赖）。 */
export async function contentHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** 读该 wiki 上次 ingest 的文件 hash 表（path → content_hash）。DB 缺失/异常 → 空 Map（退化全量重嵌）。 */
export async function loadIngestFiles(db: D1Database | undefined, wikiId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!db) return out
  try {
    const { results } = await db
      .prepare("SELECT path, content_hash FROM ingest_files WHERE wiki_id = ?")
      .bind(wikiId)
      .all<{ path: string; content_hash: string }>()
    for (const r of results) out.set(r.path, r.content_hash)
  } catch {
    // 表不存在/异常：退化全量重嵌
  }
  return out
}

/** upsert 一个文件的 hash 记录。DB 缺失/失败不抛错。 */
async function upsertIngestFile(db: D1Database | undefined, wikiId: string, path: string, hash: string): Promise<void> {
  if (!db) return
  try {
    await db
      .prepare(
        "INSERT OR REPLACE INTO ingest_files (wiki_id, path, content_hash, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(wikiId, path, hash, Date.now())
      .run()
  } catch {
    // 记录失败不阻断（下次全量重嵌兜底）
  }
}

/** 删除一个文件的 hash 记录。DB 缺失/失败不抛错。 */
async function deleteIngestFile(db: D1Database | undefined, wikiId: string, path: string): Promise<void> {
  if (!db) return
  try {
    await db.prepare("DELETE FROM ingest_files WHERE wiki_id = ? AND path = ?").bind(wikiId, path).run()
  } catch {
    // 删除失败不阻断
  }
}

/** 写一条 ingest_runs 记录。DB 缺失/写失败不抛错（记账失败不阻断 ingest）。 */
export async function recordIngestRun(db: D1Database | undefined, r: IngestResult): Promise<void> {
  if (!db) return
  const started = Date.now()
  try {
    await db
      .prepare(
        `INSERT INTO ingest_runs
          (id, wiki_id, commit_sha, status, files_added, files_updated, files_deleted,
           points_upserted, points_deleted, tokens_used, cost, key_ref, duration_ms, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        r.wiki_id,
        r.commit_sha || "",
        r.status,
        r.files_added,
        r.files_updated,
        r.files_deleted,
        r.points_upserted,
        r.points_deleted,
        r.tokens_used,
        "embed-pool",
        r.duration_ms,
        r.error ?? null,
        started,
        Date.now(),
      )
      .run()
  } catch {
    // 记账失败不阻断
  }
}

/** 删除 Qdrant 中某 path 的所有 points（按 payload.path 过滤）。 */
async function deletePointsByPath(
  baseUrl: string,
  apiKey: string | undefined,
  collection: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["api-key"] = apiKey
  const resp = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/collections/${collection}/points/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filter: { must: [{ key: "path", match: { value: path } }] } }),
  })
  if (!resp.ok) throw new Error(`qdrant-delete-failed path=${path} status=${resp.status}`)
}

/** Qdrant 批量 upsert（与 one-shot-import 行为一致，64 一批）。 */
async function upsertPoints(
  baseUrl: string,
  apiKey: string | undefined,
  collection: string,
  points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["api-key"] = apiKey
  for (let i = 0; i < points.length; i += 64) {
    const batch = points.slice(i, i + 64)
    const resp = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/collections/${collection}/points?wait=true`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ points: batch }),
    })
    if (!resp.ok) {
      const t = await resp.text().catch(() => "")
      throw new Error(`qdrant-upsert-failed status=${resp.status} detail=${t.slice(0, 200)}`)
    }
  }
}

/**
 * 增量 ingest 一个 wiki。返回 IngestResult。
 * db/env 里缺 Qdrant URL 或 D1 时仍尽力（无 Qdrant → error 结果；无 D1 → 不记账、不 skip 判断）。
 */
export async function ingestWiki(env: Env, wikiId: string, opts: { fetchImpl?: typeof fetch; nowMs?: () => number } = {}): Promise<IngestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const nowMs = opts.nowMs ?? Date.now
  const started = nowMs()
  const wiki = getWiki(wikiId)
  if (!wiki) {
    return { wiki_id: wikiId, commit_sha: "", status: "error", files_added: 0, files_updated: 0, files_deleted: 0, points_upserted: 0, points_deleted: 0, tokens_used: 0, duration_ms: nowMs() - started, error: `unknown-wiki:${wikiId}` }
  }

  // 1. 拉 tarball + commit sha（commit 拿不到不致命）
  let tree: Record<string, string>
  let commitSha = ""
  try {
    const tarball = await downloadTarball(wiki.repo, wiki.branch, fetchImpl)
    tree = stripTopDir(extractTarGz(tarball))
    commitSha = await fetchCommitSha(wiki.repo, wiki.branch, fetchImpl)
  } catch (e) {
    const msg = (e as Error)?.message ?? "github-fetch-failed"
    return { wiki_id: wikiId, commit_sha: "", status: "error", files_added: 0, files_updated: 0, files_deleted: 0, points_upserted: 0, points_deleted: 0, tokens_used: 0, duration_ms: nowMs() - started, error: msg.slice(0, 200) }
  }

  // 2. 无变更快速路径：与上次成功 commit 相同 → skip（0 upsert）
  const lastSha = await lastIngestedCommitSha(env.DB, wikiId)
  if (commitSha && lastSha && commitSha === lastSha) {
    const res: IngestResult = { wiki_id: wikiId, commit_sha: commitSha, status: "skipped", files_added: 0, files_updated: 0, files_deleted: 0, points_upserted: 0, points_deleted: 0, tokens_used: 0, duration_ms: nowMs() - started }
    await recordIngestRun(env.DB, res)
    return res
  }

  // 3. 定位 content_dir，只收 .md
  let contentDir: string
  try {
    contentDir = resolveContentDir(tree, wiki.content_dir)
  } catch (e) {
    const msg = (e as Error)?.message ?? "resolve-content-dir-failed"
    return { wiki_id: wikiId, commit_sha: commitSha, status: "error", files_added: 0, files_updated: 0, files_deleted: 0, points_upserted: 0, points_deleted: 0, tokens_used: 0, duration_ms: nowMs() - started, error: msg.slice(0, 200) }
  }
  const contentFiles = collectMarkdown(tree, contentDir).filter((f) => (f.contentDirRel.split("/").pop() ?? "") !== "_index.md")

  // 4. 文件级 diff：对每个当前 .md 算内容 hash，与 D1 ingest_files 对比。
  //    changed = 新增（无记录）或 修改（hash 变）；deleted = 有记录但当前已消失。
  //    hash 相同 → 不动（真·增量，省 embedding token）。无 ingest_files 表/DB 时全量当 changed（幂等兜底）。
  const current = new Map<string, string>() // path(repoRoot) → content_hash
  for (const f of contentFiles) {
    current.set(f.repoRootPath, await contentHash(f.content))
  }
  const prevHashes = await loadIngestFiles(env.DB, wiki.id)

  const changedPaths: string[] = []
  const unchangedPaths: string[] = []
  for (const [path, hash] of current) {
    if (prevHashes.get(path) === hash) unchangedPaths.push(path)
    else changedPaths.push(path)
  }
  const deletedPaths = [...prevHashes.keys()].filter((p) => !current.has(p))
  const addedCount = changedPaths.filter((p) => !prevHashes.has(p)).length
  const updatedCount = changedPaths.length - addedCount

  // 5. 只解析 changed 文件 → chunk（含文本，供 embed 与 Qdrant payload.text 全文索引）
  const dirMeta = buildDirMeta(contentFiles.map((f) => ({ path: f.contentDirRel, content: f.content })))
  const chunks: Array<{ record: ChunkRecord; text: string }> = []
  for (const f of contentFiles.sort((a, b) => a.repoRootPath.localeCompare(b.repoRootPath))) {
    if (!changedPaths.includes(f.repoRootPath)) continue // hash 相同：跳过
    const base = f.contentDirRel.split("/").pop() ?? f.contentDirRel
    const { meta, body: rawBody } = parseFrontmatter(f.content)
    const body = cleanBody(rawBody)
    const pathMeta = resolvePathMeta(f.contentDirRel, dirMeta, null)
    const title = String(meta.title ?? meta.name ?? base.replace(/\.md$/, "")).trim()
    const url = buildSiteUrl(wiki.id, { repoRootPath: f.repoRootPath, contentDirRel: f.contentDirRel, meta })
    const items = chunkMarkdownWithText(
      {
        wiki_id: wiki.id,
        path: f.repoRootPath,
        title,
        section: pathMeta,
        body,
        url,
        commit_sha: commitSha,
        updated_at: new Date(nowMs()).toISOString(),
      },
      { maxChars: wiki.chunk_max_chars ?? 1200, overlap: 150 },
    )
    chunks.push(...items)
  }

  // 6. 对 changed 文件 embed + upsert（幂等 point id）
  let pointsUpserted = 0
  let tokensUsed = 0
  if (chunks.length > 0 && env.QDRANT_URL) {
    const { provider } = createEmbeddingProvider(env, noopDb, fetchImpl)
    const batchSize = wiki.embed_batch_size ?? 32
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const vectors = await provider.embedBatch(batch.map((c) => c.text), { kind: "document", batch: { batchSize } })
      const points = batch.map((c, j) => ({
        id: pointId(c.record.wiki_id, c.record.path, c.record.chunk_index),
        vector: vectors[j],
        payload: {
          wiki_id: c.record.wiki_id,
          path: c.record.path,
          title: c.record.title,
          section: c.record.section,
          url: c.record.url,
          commit_sha: c.record.commit_sha,
          chunk_index: c.record.chunk_index,
          updated_at: c.record.updated_at,
          text: c.text,
        },
      }))
      await upsertPoints(env.QDRANT_URL, env.QDRANT_API_KEY, collName(wiki.id), points, fetchImpl)
      // 注：曾经在这里写 D1 `bigram_index` 倒排索引（回退分支用）。该表已废弃并删除
      // （见 src/bigram.ts 文件头与 schemaStatements.ts 的 DROP 迁移）：回退检索改用 Qdrant 全文索引，
      // 表只写不读且写放大超免费额度 5 倍。**不要**再把写入加回来。
      pointsUpserted += points.length
    }
    tokensUsed = chunks.reduce((acc, c) => acc + Math.ceil(c.text.length / 2), 0)
  }

  // 7. 删除消失文件：Qdrant points + ingest_files 记录
  let pointsDeleted = 0
  for (const p of deletedPaths) {
    try {
      if (env.QDRANT_URL) {
        await deletePointsByPath(env.QDRANT_URL, env.QDRANT_API_KEY, collName(wiki.id), p, fetchImpl)
        pointsDeleted++
      }
      await deleteIngestFile(env.DB, wiki.id, p)
    } catch {
      // 单 path 删除失败不阻断
    }
  }

  // 8. 更新 ingest_files：changed 文件写新 hash
  for (const p of changedPaths) {
    const h = current.get(p)
    if (h) await upsertIngestFile(env.DB, wiki.id, p, h)
  }

  const res: IngestResult = {
    wiki_id: wiki.id,
    commit_sha: commitSha,
    status: "success",
    files_added: addedCount,
    files_updated: updatedCount,
    files_deleted: deletedPaths.length,
    points_upserted: pointsUpserted,
    points_deleted: pointsDeleted,
    tokens_used: tokensUsed,
    duration_ms: nowMs() - started,
  }
  await recordIngestRun(env.DB, res)
  return res
}