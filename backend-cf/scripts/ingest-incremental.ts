#!/usr/bin/env tsx
// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — Node 增量摄取脚本（GitHub Actions / 本地均可跑）
//
// 为什么不在 Worker 里跑：Cloudflare 免费版 CPU 10ms / 内存 128MB / 单次 50 子请求，
// 下载整仓 tarball + gunzip + embed 必然 exceededMemory / exceededCpu（已实测）。
// 本脚本在 Node 环境无这些限制，直接复用 src/ 下的纯逻辑（parser / wikiUrl / embeddings）。
//
// 真·增量：
//   1. GitHub trees API 一次拿到 全部 .md 路径 → git blob sha（内容指纹，比 commit sha 细到文件级）
//   2. 从 Qdrant 读出已入库每个 path 的 blob_sha（payload.blob_sha）
//   3. 只对 blob_sha 变化的文件重新解析/embed/upsert；消失的文件删点
//   4. 不变的文件零请求、零 embedding
//
// 用法：
//   QDRANT_URL=... QDRANT_API_KEY=... EMBED_POOL_KEYS=... GITHUB_TOKEN=... \
//     npx tsx scripts/ingest-incremental.ts [--only=mtf-wiki] [--full] [--dry-run]

import { listWikis, collectionName } from "../src/wiki_registry"
import { buildSiteUrl } from "../src/wikiUrl"
import {
  parseFrontmatter,
  cleanBody,
  buildDirMeta,
  resolvePathMeta,
  chunkMarkdownWithText,
  pointId,
  type ChunkRecord,
} from "../src/ingest/parser"
import { createEmbeddingProvider } from "../src/embeddings"
import { ensureCollection, upsertPoints, type QdrantPoint } from "./one-shot-import"
import type { KeyPoolDb } from "../src/keypool"

// ── CLI ──
const argv = process.argv.slice(2)
const FULL = argv.includes("--full")
const DRY = argv.includes("--dry-run")
const ONLY = argv.find((a) => a.startsWith("--only="))?.split("=")[1]

// ── 环境 ──
const QDRANT_URL = (process.env.QDRANT_URL ?? "").trim().replace(/\/+$/, "")
const QDRANT_API_KEY = (process.env.QDRANT_API_KEY ?? "").trim()
const EMBED_POOL_KEYS = (process.env.EMBED_POOL_KEYS ?? "").trim()
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN ?? "").trim()
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM ?? "1024", 10)

if (!QDRANT_URL) throw new Error("缺少 QDRANT_URL")
if (!EMBED_POOL_KEYS) throw new Error("缺少 EMBED_POOL_KEYS")

const noopDb: KeyPoolDb = { async recordUsage() {} }

// ── GitHub ──
interface TreeEntry {
  path: string
  type: string
  sha: string
}

async function ghJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "transhelper-prism-ingest",
  }
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`
  const resp = await fetch(url, { headers })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`github ${resp.status} ${url} ${body.slice(0, 160)}`)
  }
  return (await resp.json()) as T
}

async function ghRaw(repo: string, branch: string, path: string): Promise<string> {
  const resp = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`, {
    headers: { "User-Agent": "transhelper-prism-ingest" },
  })
  if (!resp.ok) throw new Error(`raw ${resp.status} ${repo}@${branch}/${path}`)
  return await resp.text()
}

/** 列出分支上全部 blob（path → git blob sha）。recursive tree 一次拿全。 */
async function listTree(repo: string, branch: string): Promise<TreeEntry[]> {
  const j = await ghJson<{ tree?: TreeEntry[]; truncated?: boolean }>(
    `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
  )
  if (j.truncated) throw new Error(`tree truncated: ${repo}@${branch}（仓库过大，需要按目录递归）`)
  return j.tree ?? []
}

/** 取分支当前 head commit sha（写进 payload，便于追溯）。 */
async function headSha(repo: string, branch: string): Promise<string> {
  try {
    const j = await ghJson<{ sha?: string }>(`https://api.github.com/repos/${repo}/commits/${branch}`)
    return j.sha ?? ""
  } catch {
    return ""
  }
}

// ── Qdrant ──
function qdrantHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" }
  if (QDRANT_API_KEY) h["api-key"] = QDRANT_API_KEY
  return h
}

interface ExistingPath {
  blobSha?: string
  /** 该 path 已入库的 point id（用于按 id 删除，避免依赖 payload 索引）。 */
  ids: Array<string | number>
}

/** scroll 整个 collection，返回 path → { blobSha, ids }（blob_sha 为新增字段，旧数据可能没有）。 */
async function readExisting(collection: string): Promise<Map<string, ExistingPath>> {
  const out = new Map<string, ExistingPath>()
  let offset: unknown = undefined
  for (let page = 0; page < 500; page++) {
    const body: Record<string, unknown> = { limit: 256, with_payload: true, with_vector: false }
    if (offset !== undefined && offset !== null) body.offset = offset
    const resp = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: qdrantHeaders(),
      body: JSON.stringify(body),
    })
    if (resp.status === 404) return out // 库还不存在 → 全量
    if (!resp.ok) throw new Error(`scroll ${collection} status=${resp.status}`)
    const j = (await resp.json()) as {
      result?: {
        points?: Array<{ id?: string | number; payload?: Record<string, unknown> }>
        next_page_offset?: unknown
      }
    }
    for (const p of j.result?.points ?? []) {
      const path = typeof p.payload?.path === "string" ? (p.payload.path as string) : ""
      if (!path || p.id === undefined || p.id === null) continue
      const sha = typeof p.payload?.blob_sha === "string" ? (p.payload.blob_sha as string) : undefined
      const cur = out.get(path)
      if (cur) cur.ids.push(p.id)
      else out.set(path, { blobSha: sha, ids: [p.id] })
    }
    const next = j.result?.next_page_offset
    if (next === null || next === undefined) break
    offset = next
  }
  return out
}

/** 按 point id 批量删除（Qdrant 单次上限内分批）。 */
async function deleteByIds(collection: string, ids: Array<string | number>): Promise<void> {
  if (ids.length === 0) return
  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000)
    const resp = await fetch(`${QDRANT_URL}/collections/${collection}/points/delete?wait=true`, {
      method: "POST",
      headers: qdrantHeaders(),
      body: JSON.stringify({ points: batch }),
    })
    if (!resp.ok) {
      const t = await resp.text().catch(() => "")
      throw new Error(`delete ${collection} status=${resp.status} ${t.slice(0, 160)}`)
    }
  }
}

// ── 主流程 ──
interface WikiSummary {
  wiki_id: string
  files_total: number
  changed: number
  removed: number
  chunks: number
  points_upserted: number
  seconds: number
  skipped?: boolean
}

async function runWiki(wikiId: string): Promise<WikiSummary> {
  const wiki = listWikis().find((w) => w.id === wikiId)
  if (!wiki) throw new Error(`unknown-wiki:${wikiId}`)
  const started = Date.now()
  const collection = collectionName(wiki.id)
  const prefix = wiki.content_dir ? `${wiki.content_dir}/` : ""

  const tree = await listTree(wiki.repo, wiki.branch)
  const md = tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix) && e.path.toLowerCase().endsWith(".md"))
  const mdSet = new Set(md.map((e) => e.path))

  const existing = DRY ? new Map<string, ExistingPath>() : await readExisting(collection)
  const changed = md.filter((e) => FULL || existing.get(e.path)?.blobSha !== e.sha)
  const removed = [...existing.keys()].filter((p) => !mdSet.has(p))

  if (changed.length === 0 && removed.length === 0) {
    console.log(`  [${wiki.id}] 无变更（${md.length} 个 .md），跳过`)
    return { wiki_id: wiki.id, files_total: md.length, changed: 0, removed: 0, chunks: 0, points_upserted: 0, seconds: (Date.now() - started) / 1000, skipped: true }
  }

  // 目录元数据（section 标题）永远需要 _index.md 的 frontmatter——单独拉取（数量少）。
  const indexEntries = md.filter((e) => (e.path.split("/").pop() ?? "") === "_index.md")
  const indexFiles = await Promise.all(
    indexEntries.map(async (e) => ({ path: e.path.slice(prefix.length), content: await ghRaw(wiki.repo, wiki.branch, e.path) })),
  )
  const dirMeta = buildDirMeta(indexFiles)

  // 变更文件内容（_index.md 只作目录元数据，不入库）
  const targets = changed.filter((e) => (e.path.split("/").pop() ?? "") !== "_index.md")
  const contents = await Promise.all(
    targets.map(async (e) => ({ entry: e, content: await ghRaw(wiki.repo, wiki.branch, e.path) })),
  )

  const sha = await headSha(wiki.repo, wiki.branch)
  const chunks: Array<{ record: ChunkRecord; text: string; blobSha: string }> = []
  for (const { entry, content } of contents) {
    const contentDirRel = entry.path.slice(prefix.length)
    const base = contentDirRel.split("/").pop() ?? contentDirRel
    const { meta, body: rawBody } = parseFrontmatter(content)
    const body = cleanBody(rawBody)
    const section = resolvePathMeta(contentDirRel, dirMeta, null)
    const title = String(meta.title ?? meta.name ?? base.replace(/\.md$/i, "")).trim()
    const url = buildSiteUrl(wiki.id, { repoRootPath: entry.path, contentDirRel, meta })
    const items = chunkMarkdownWithText(
      {
        wiki_id: wiki.id,
        path: entry.path,
        title,
        section,
        body,
        url,
        commit_sha: sha,
        updated_at: new Date().toISOString(),
      },
      { maxChars: wiki.chunk_max_chars ?? 1200, overlap: 150 },
    )
    for (const it of items) chunks.push({ ...it, blobSha: entry.sha })
  }

  console.log(
    `  [${wiki.id}] .md=${md.length} changed=${targets.length} removed=${removed.length} chunks=${chunks.length}${DRY ? " (dry-run)" : ""}`,
  )
  if (DRY) {
    return { wiki_id: wiki.id, files_total: md.length, changed: targets.length, removed: removed.length, chunks: chunks.length, points_upserted: 0, seconds: (Date.now() - started) / 1000 }
  }

  // 先按 id 删掉受影响 path 的旧点（变更文件可能 chunk 数变少；消失文件整条移除），再写新点。
  // 用 id 删除而非 payload filter：后者要求先给 path 字段建索引（Qdrant 会返回 400）。
  const affectedPaths = new Set([...targets.map((e) => e.path), ...removed])
  const affectedIds: Array<string | number> = []
  for (const p of affectedPaths) {
    const ex = existing.get(p)
    if (ex) affectedIds.push(...ex.ids)
  }
  await deleteByIds(collection, affectedIds)

  let upserted = 0
  if (chunks.length > 0) {
    await ensureCollection(QDRANT_URL, QDRANT_API_KEY, collection, EMBEDDING_DIM, fetch)
    const { provider } = createEmbeddingProvider({ EMBED_POOL_KEYS }, noopDb)
    const batchSize = 32
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const vectors = await provider.embedBatch(
        batch.map((c) => c.text),
        { kind: "document", batch: { batchSize } },
      )
      const points: QdrantPoint[] = batch.map((c, j) => ({
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
          blob_sha: c.blobSha, // 供下次增量比对
        },
      }))
      await upsertPoints(QDRANT_URL, QDRANT_API_KEY, collection, points, fetch)
      upserted += points.length
    }
  }

  return {
    wiki_id: wiki.id,
    files_total: md.length,
    changed: targets.length,
    removed: removed.length,
    chunks: chunks.length,
    points_upserted: upserted,
    seconds: (Date.now() - started) / 1000,
  }
}

async function main() {
  const wikis = ONLY ? [ONLY] : listWikis().map((w) => w.id)
  console.log(`增量摄取：${wikis.join(", ")}${FULL ? "（--full 强制全量重嵌）" : ""}${DRY ? " [dry-run]" : ""}`)
  const summaries: WikiSummary[] = []
  for (const id of wikis) {
    summaries.push(await runWiki(id))
  }
  const totals = summaries.reduce(
    (a, s) => ({ changed: a.changed + s.changed, removed: a.removed + s.removed, upserted: a.upserted + s.points_upserted }),
    { changed: 0, removed: 0, upserted: 0 },
  )
  console.log(`\n完成：changed=${totals.changed} removed=${totals.removed} upserted=${totals.upserted}`)
  for (const s of summaries) {
    console.log(`  ${s.wiki_id}: files=${s.files_total} changed=${s.changed} removed=${s.removed} chunks=${s.chunks} upsert=${s.points_upserted} ${s.seconds.toFixed(1)}s${s.skipped ? " (skip)" : ""}`)
  }
}

main().catch((e) => {
  console.error(`摄取失败：${(e as Error)?.message ?? String(e)}`)
  process.exit(1)
})
