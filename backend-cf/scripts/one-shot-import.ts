// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 一次性全量导入 (tasks.md T0.3 / plan.md §7)
// 从 GitHub tarball 拉取 4 个 wiki，解析→分块→embedBatch→Qdrant Cloud REST upsert。
//   库名：{wiki_id}_v1；point id = sha1(wiki_id:path:chunk_index)（Qdrant UUID 形）。
//   支持 --dry-run（只数 chunks/token，不调任何 API）、--only=<id> 单库、--resume（断点续跑）。
// 所有 key 从环境变量读：QDRANT_URL / QDRANT_API_KEY / SILICONFLOW_API_KEY，缺了报错退出，绝不硬编码。
// 本脚本跑在 Workers 外（tsx / node），不装 Qdrant client，直接 fetch REST；绝不打印 key。

import { readdir, readFile, mkdir, appendFile } from "node:fs/promises"
import { join, sep } from "node:path"
import { gunzipSync } from "node:zlib"
import { parseFrontmatter, cleanBody, buildDirMeta, resolvePathMeta, chunkMarkdownWithText, pointId } from "../src/ingest/parser"
import type { ChunkRecord } from "../src/ingest/parser"
import { SiliconFlowEmbedding, estimateTokens } from "../src/embeddings"
import { KeyPool } from "../src/keypool"

// ─────────────────────────────────────────────────────────────
// Wiki 配置（首批 4 库，plan.md §7.2；新增 wiki 只需加一行，零代码改动）
// ─────────────────────────────────────────────────────────────
export interface WikiConfig {
  id: string
  name: string
  repo: string
  content_dir: string
  site_url: string
  chunk: { maxChars: number; overlap: number }
}

export const DEFAULT_WIKIS: WikiConfig[] = [
  // 各库 content_dir 不同：mtf 只收 zh-cn（不收 ja/zh-hant/en）；ftm 整个 content；rle/mio 用 docs。
  // site_url 为占位，URL 现默认拼 GitHub blob 链接（https://github.com/{repo}/blob/{branch}/{path}），site_url 以后覆盖。
  { id: "mtf-wiki", name: "MtF Wiki", repo: "project-trans/MtF-wiki", content_dir: "content/zh-cn", site_url: "https://github.com/project-trans/MtF-wiki/blob/main", chunk: { maxChars: 1200, overlap: 150 } },
  { id: "ftm-wiki", name: "FtM Wiki", repo: "project-trans/FtM-wiki", content_dir: "content", site_url: "https://github.com/project-trans/FtM-wiki/blob/main", chunk: { maxChars: 1200, overlap: 150 } },
  { id: "rle-wiki", name: "RLE Wiki", repo: "project-trans/rle-wiki", content_dir: "docs", site_url: "https://github.com/project-trans/rle-wiki/blob/main", chunk: { maxChars: 1200, overlap: 150 } },
  { id: "miomtfwiki", name: "Mio MtF Wiki", repo: "KitsuMio/MioMtFWiki", content_dir: "docs", site_url: "https://github.com/KitsuMio/MioMtFWiki/blob/main", chunk: { maxChars: 1200, overlap: 150 } },
]

export interface ImportEnv {
  QDRANT_URL?: string
  QDRANT_API_KEY?: string
  SILICONFLOW_API_KEY?: string
  EMBEDDING_MODEL?: string
  EMBEDDING_DIM?: string
  EMBEDDING_ENDPOINT?: string
}

/** 从环境变量读取 key/配置。缺了抛错（dry-run 除外）。 */
export function requireEnv(env: ImportEnv, params: { dryRun: boolean }): {
  qdrantUrl: string
  qdrantKey: string
  siliconflowKey: string
  model: string
  dim: number
  endpoint: string
} {
  const qdrantUrl = env.QDRANT_URL?.replace(/\/+$/, "") ?? ""
  const qdrantKey = env.QDRANT_API_KEY ?? ""
  const siliconflowKey = env.SILICONFLOW_API_KEY ?? ""
  const model = env.EMBEDDING_MODEL ?? "BAAI/bge-m3"
  const dim = parseInt(env.EMBEDDING_DIM ?? "1024", 10)
  const endpoint = (env.EMBEDDING_ENDPOINT ?? "https://api.siliconflow.cn/v1/embeddings").replace(/\/+$/, "")

  const missing: string[] = []
  if (!params.dryRun) {
    if (!qdrantUrl) missing.push("QDRANT_URL")
    if (!qdrantKey) missing.push("QDRANT_API_KEY")
    if (!siliconflowKey) missing.push("SILICONFLOW_API_KEY")
    if (missing.length > 0) {
      throw new Error(`缺少必需环境变量：${missing.join(", ")}（非 --dry-run 模式必须提供；dry-run 可省略）`)
    }
  }
  return { qdrantUrl, qdrantKey, siliconflowKey, model, dim, endpoint }
}

// ─────────────────────────────────────────────────────────────
// 分支探测 / tarball 拉取 / 解包（无重型依赖：自己解 tar.gz）
// ─────────────────────────────────────────────────────────────
async function probeDefaultBranch(repo: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const resp = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "transhelper-prism-ingest" },
    })
    if (resp.ok) {
      const j = (await resp.json()) as { default_branch?: string }
      if (j.default_branch) return j.default_branch
    }
  } catch {
    // 忽略，走 main/master 兜底
  }
  // 兜底：取 main/master 第一个存在的
  for (const candidate of ["main", "master"]) {
    try {
      const resp = await fetchImpl(`https://github.com/${repo}/archive/refs/heads/${candidate}.tar.gz`, { method: "HEAD" })
      if (resp.ok) return candidate
    } catch {
      // 继续尝试下一个
    }
  }
  throw new Error(`无法探测 ${repo} 的默认分支（main/master 均不可用）`)
}

/** 从 GitHub 拉取 branch 的 tarball 原始字节。 */
async function downloadTarball(repo: string, branch: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const url = `https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`
  const resp = await fetchImpl(url)
  if (!resp.ok) throw new Error(`tarball 下载失败 ${repo}@${branch} status=${resp.status}`)
  const buf = await resp.arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * 极简 tar 解包：返回 文件相对路径 -> utf8 文本 的映射（只保留我们关心的文本条目）。
 * 支持 GNU 长文件名（typeflag 'L'/长链接名 'K'）：其 data 块存储真实 name，
 * 下一个条目应用它为 name。若路径超 ustar 100(+155 prefix) 限制（如 MtF 108 字符路径），
 * GNU tar 会用 'L' 条目，跳过会导致整条目录丢失。此处显式解析并应用。
 */
export function extractTarGz(buf: Uint8Array): Record<string, string> {
  const raw = gunzipSync(buf)
  const files: Record<string, string> = {}
  const decoder = new TextDecoder("utf-8")
  let offset = 0
  // GNU 'L'/'K' 条目：其 data 块存真实长 name（或 linkname），应用到下一个条目
  let pendingLongName: string | null = null

  const readString = (start: number, len: number): string => {
    const bytes = raw.subarray(start, start + len)
    let end = 0
    while (end < bytes.length && bytes[end] !== 0) end++
    return decoder.decode(bytes.subarray(0, end))
  }

  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    // 全零块：tar 结束
    if (header.every((b) => b === 0)) break

    let name = readString(offset, 100)
    const sizeStr = readString(offset + 124, 12).trim()
    const typeflag = String.fromCharCode(raw[offset + 156])
    const prefix = readString(offset + 345, 155)

    if (prefix) name = `${prefix}/${name}`

    const size = sizeStr ? parseInt(sizeStr, 8) : 0
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const data = raw.subarray(dataStart, dataEnd)

    if (typeflag === "L" || typeflag === "K") {
      // GNU 长名/长链接名：data 块（连同结尾 NUL/换行）是真实 name，保存给下一个条目
      pendingLongName = decoder.decode(data).replace(/\0+$/, "").replace(/\n$/, "").trim()
    } else {
      // 正规文件（typeflag 0 或 '0' 或空）才取内容；长名条目已修正 name
      if ((typeflag === "0" || typeflag === "\x00" || typeflag === "") && size >= 0) {
        const effectiveName = pendingLongName ?? name
        files[effectiveName] = decoder.decode(data)
      }
      pendingLongName = null // 长名只作用于紧随其后的一个条目
    }

    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

/**
 * 从"repo-root-relative"文件树里找到实际 content 根目录（自适应 content_dir）。
 * 调用方需先确保 tree 的 key 已去掉顶层 `{repo}-{branch}`（tarball 路径）或本身即 repo 根（local 路径）。
 */
export function resolveContentDir(tree: Record<string, string>, prefer: string): string {
  const pref = prefer.replace(/^\/+|\/+$/g, "")
  if (Object.keys(tree).some((k) => k.startsWith(pref + "/") || k === pref)) return pref

  // 找不到直接报错并列出可用候选
  const topLevels = new Set<string>()
  for (const k of Object.keys(tree)) {
    const first = k.split("/").filter(Boolean)[0]
    if (first) topLevels.add(first)
  }
  const secondLevels = new Set<string>()
  for (const k of Object.keys(tree)) {
    const parts = k.split("/").filter(Boolean)
    if (parts.length >= 2) secondLevels.add(`${parts[0]}/${parts[1]}`)
  }
  throw new Error(
    `content_dir "${prefer}" 不存在。库内可用顶层目录：${[...topLevels].join(", ") || "(空)"}；` +
      `二级：${[...secondLevels].join(", ") || "(无)"}。请检查 content_dir 配置。`,
  )
}

/** 去掉 tarball 顶层 `{repo}-{branch}` 目录，得到 repo-root-relative 树。 */
function stripTopDir(tree: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(tree)) {
    const parts = k.split("/").filter(Boolean)
    out[parts.slice(1).join("/")] = v
  }
  return out
}

/** 从本地目录收集 content_dir 下所有 .md（dry-run fixture / 本地演示用）。 */
async function walkLocalFiles(dir: string, base = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = join(dir, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      Object.assign(out, await walkLocalFiles(full, rel))
    } else if (e.isFile()) {
      out[rel] = await readFile(full, "utf-8")
    }
  }
  return out
}

/** 拿到仓库 commit sha（用于记录到 chunk）。失败返回空串。 */
async function fetchCommitSha(repo: string, branch: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const resp = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${branch}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "transhelper-prism-ingest" },
    })
    if (resp.ok) {
      const j = (await resp.json()) as { sha?: string }
      return j.sha ?? ""
    }
  } catch {
    // 忽略
  }
  return ""
}

// ─────────────────────────────────────────────────────────────
// Qdrant REST（幂等建库 + upsert）
// ─────────────────────────────────────────────────────────────
export interface QdrantPoint {
  id: string
  vector: number[]
  payload: Record<string, unknown>
}

async function qdrantFetch(
  url: string,
  key: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(`${url}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "api-key": key, ...(init.headers ?? {}) },
  })
}

export async function ensureCollection(base: string, key: string, name: string, dim: number, fetchImpl: typeof fetch): Promise<void> {
  const exists = await qdrantFetch(base, key, `/collections/${name}`, { method: "GET" }, fetchImpl)
  if (exists.ok) return
  if (exists.status !== 404) {
    throw new Error(`检查 collection ${name} 失败 status=${exists.status}`)
  }
  const create = await qdrantFetch(
    base,
    key,
    `/collections/${name}`,
    {
      method: "PUT",
      body: JSON.stringify({ vectors: { size: dim, distance: "Cosine" } }),
    },
    fetchImpl,
  )
  if (!create.ok) {
    const t = await create.text().catch(() => "")
    throw new Error(`创建 collection ${name} 失败 status=${create.status} detail=${t.slice(0, 200)}`)
  }
}

export async function upsertPoints(
  base: string,
  key: string,
  name: string,
  points: QdrantPoint[],
  fetchImpl: typeof fetch,
): Promise<void> {
  // Qdrant 单次 upsert 有上限，拆成 64 一批
  for (let i = 0; i < points.length; i += 64) {
    const batch = points.slice(i, i + 64)
    const resp = await qdrantFetch(
      base,
      key,
      `/collections/${name}/points?wait=true`,
      { method: "PUT", body: JSON.stringify({ points: batch }) },
      fetchImpl,
    )
    if (!resp.ok) {
      const t = await resp.text().catch(() => "")
      throw new Error(`upsert ${name} 失败 status=${resp.status} detail=${t.slice(0, 200)}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Checkpoint（JSONL，断点续跑）
// ─────────────────────────────────────────────────────────────
export interface Checkpoint {
  dir: string
  file: string
}

function checkpointPath(stateDir: string, wikiId: string): string {
  return join(stateDir, `${wikiId}.jsonl`)
}

async function loadCheckpoint(stateDir: string, wikiId: string): Promise<Set<string>> {
  const done = new Set<string>()
  try {
    const raw = await readFile(checkpointPath(stateDir, wikiId), "utf-8")
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line) as { point_id?: string }
        if (obj.point_id) done.add(obj.point_id)
      } catch {
        // 跳过坏行
      }
    }
  } catch {
    // 文件不存在：从头跑
  }
  return done
}

async function appendCheckpoint(stateDir: string, wikiId: string, pointIdStr: string): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await appendFile(checkpointPath(stateDir, wikiId), JSON.stringify({ point_id: pointIdStr }) + "\n", "utf-8")
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────
interface CliArgs {
  dryRun: boolean
  only: string | null
  resume: boolean
  localDir: string | null
  chunkMaxChars: number
  chunkOverlap: number
  batchSize: number
  maxRetries: number
  stateDir: string
  fetchImpl: typeof fetch
}

function parseArgs(argv: string[]): { help: boolean } & Partial<CliArgs> {
  const out: { help: boolean } & Partial<CliArgs> = { help: false, dryRun: false, only: null, resume: false, localDir: null, batchSize: 32, maxRetries: 6, stateDir: ".ingest" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") out.help = true
    else if (a === "--dry-run") out.dryRun = true
    else if (a === "--resume") out.resume = true
    else if (a === "--batch-size") out.batchSize = parseInt(argv[++i] ?? "32", 10)
    else if (a === "--max-retries") out.maxRetries = parseInt(argv[++i] ?? "6", 10)
    else if (a === "--state-dir") out.stateDir = argv[++i] ?? ".ingest"
    else if (a === "--local-dir") out.localDir = argv[++i] ?? null
    else if (a === "--only") out.only = argv[++i] ?? null
    else if (a.startsWith("--only=")) out.only = a.slice("--only=".length)
    else if (a.startsWith("--local-dir=")) out.localDir = a.slice("--local-dir=".length)
  }
  return out
}

export interface RunResult {
  wiki_id: string
  repo: string
  branch: string
  content_dir: string
  files: number
  chunks: number
  tokens: number
  pointsUpserted: number
  skipped: number
  durationMs: number
}

export async function runImport(args: CliArgs, env: ImportEnv): Promise<{ results: RunResult[]; totals: { chunks: number; tokens: number } }> {
  const cfg = requireEnv(env, { dryRun: args.dryRun })
  const wikis = (args.only ? DEFAULT_WIKIS.filter((w) => w.id === args.only) : DEFAULT_WIKIS)
  if (args.only && wikis.length === 0) throw new Error(`未知 wiki：${args.only}`)

  // 仅 dry-run 或需要 key 时构造 provider
  let provider: SiliconFlowEmbedding | null = null
  if (!args.dryRun) {
    const pool = new KeyPool({ EMBED_POOL_KEYS: cfg.siliconflowKey, LLM_POOL_KEYS: cfg.siliconflowKey }, { recordUsage: async () => {} })
    provider = new SiliconFlowEmbedding({ model: cfg.model, dim: cfg.dim, endpoint: cfg.endpoint }, pool, args.fetchImpl)
  }

  const results: RunResult[] = []
  let totalChunks = 0
  let totalTokens = 0

  for (const wiki of wikis) {
    const started = Date.now()
    console.log(`\n===== ${wiki.name} (${wiki.id} / ${wiki.repo}) =====`)

    // 1. 拿到文件树（repo-root-relative：path -> 内容）
    let tree: Record<string, string>
    let commitSha = ""
    let branch = ""
    if (args.localDir) {
      // --local-dir 指向 repo 根（已解包的目录）；再从其中按 content_dir 取子集
      tree = await walkLocalFiles(args.localDir)
      commitSha = "local-fixture"
      branch = "local"
      console.log(`  · 来源：本地目录 ${args.localDir}`)
    } else {
      branch = await probeDefaultBranch(wiki.repo, args.fetchImpl)
      const tarball = await downloadTarball(wiki.repo, branch, args.fetchImpl)
      tree = stripTopDir(extractTarGz(tarball))
      commitSha = await fetchCommitSha(wiki.repo, branch, args.fetchImpl)
      console.log(`  · 分支：${branch}  commit: ${commitSha || "(未知)"}  tarball: ${Object.keys(tree).length} 个条目`)
    }

    // 2. 自适应 content_dir（只在 content_dir 子树内取文件，天然排除 themes/.agents/其它语言等）
    const contentDir = resolveContentDir(tree, wiki.content_dir)
    const prefix = contentDir ? `${contentDir}/` : ""
    // 只收 .md 文本（其它 jpg/png/pdf 等静态资产不属于检索内容，且像 MtF 里有 251 个图片/PDF 会被当 UTF-8 误读）
    const contentFiles: Array<{ repoRootPath: string; contentDirRel: string; content: string }> = []
    for (const [repoRootPath, content] of Object.entries(tree)) {
      if (repoRootPath === contentDir || repoRootPath.startsWith(prefix)) {
        if (repoRootPath.split("/").pop()?.toLowerCase().endsWith(".md")) {
          contentFiles.push({ repoRootPath, contentDirRel: repoRootPath.slice(prefix.length), content })
        }
      }
    }

    // 3. _index.md 目录元映射（用 content_dir-relative 路径）
    const dirMeta = buildDirMeta(contentFiles.map((f) => ({ path: f.contentDirRel, content: f.content })))

    // 4. 逐文件解析 → chunk（含文本，供 embed）
    const chunkRecords: Array<{ record: ChunkRecord; text: string }> = []
    let skipped = 0
    let fileCount = 0
    for (const f of contentFiles.sort((a, b) => a.repoRootPath.localeCompare(b.repoRootPath))) {
      const base = f.contentDirRel.split("/").pop() ?? f.contentDirRel
      if (base === "_index.md") continue // 仅作目录元数据，不入库
      const { meta, body: rawBody } = parseFrontmatter(f.content)
      const body = cleanBody(rawBody)
      const pathMeta = resolvePathMeta(f.contentDirRel, dirMeta, null)
      const title = String(meta.title ?? meta.name ?? base.replace(/\.md$/, "")).trim()
      // URL 默认拼 GitHub blob 链接（https://github.com/{repo}/blob/{branch}/{repoRootPath}），site_url 以后覆盖
      const url = `https://github.com/${wiki.repo}/blob/${branch}/${f.repoRootPath}`
      const items = chunkMarkdownWithText(
        {
          wiki_id: wiki.id,
          path: f.repoRootPath,
          title,
          section: pathMeta,
          body,
          url,
          commit_sha: commitSha,
          updated_at: new Date().toISOString(),
        },
        { maxChars: args.chunkMaxChars, overlap: args.chunkOverlap },
      )
      chunkRecords.push(...items)
      if (items.length === 0) skipped++
      fileCount++
    }
    const chunks = chunkRecords.length
    const tokens = estimateTokens(chunkRecords.map((c) => c.text))
    const durationMs = Date.now() - started

    console.log(`  · 文件：${fileCount}  分块：${chunks}  token粗估：${tokens}  跳过：${skipped}`)

    if (args.dryRun) {
      console.log(`  · DRY-RUN：不调用任何 API，跳过 embed/upsert`)
      results.push({ wiki_id: wiki.id, repo: wiki.repo, branch, content_dir: contentDir, files: fileCount, chunks, tokens, pointsUpserted: 0, skipped, durationMs })
      totalChunks += chunks
      totalTokens += tokens
      continue
    }

    // 5. 真实模式：建库（幂等）→ embed → upsert
    // 库名规范（plan §7.1，与 search.ts collectionName() 对齐）：横杠转下划线 + _v1，
    // 即 mtf_wiki_v1 / ftm_wiki_v1 / rle_wiki_v1 / miomtfwiki_v1。2026-09-07 修：首版用了
    // 原始 id（含横杠）导致检索查不到库（仅无横杠的 miomtfwiki 能中），旧横杠库需手动删除。
    if (!provider) throw new Error("provider 未初始化")
    const collectionName = `${wiki.id.replace(/-/g, "_")}_v1`
    await ensureCollection(cfg.qdrantUrl, cfg.qdrantKey, collectionName, cfg.dim, args.fetchImpl)
    console.log(`  · collection ${collectionName} 就绪（dim=${cfg.dim}）`)

    const done = args.resume ? await loadCheckpoint(args.stateDir, wiki.id) : new Set<string>()
    const toEmbed = chunkRecords.filter((c) => !done.has(pointId(c.record.wiki_id, c.record.path, c.record.chunk_index)))
    console.log(`  · 待嵌入：${toEmbed.length} / ${chunks}（checkpoint 已有 ${chunks - toEmbed.length}）`)

    let pointsUpserted = 0

    // 分批 embed
    let idx = 0
    while (idx < toEmbed.length) {
      const batch = toEmbed.slice(idx, idx + args.batchSize)
      const texts = batch.map((c) => c.text)
      const vectors = await provider.embedBatch(texts, { kind: "document", batch: { batchSize: args.batchSize, maxRetries: args.maxRetries } })
      const points: QdrantPoint[] = batch.map((c, i) => ({
        id: pointId(c.record.wiki_id, c.record.path, c.record.chunk_index),
        vector: vectors[i],
        // text 必须入库：搜索 snippet、M3 LLM 总结 context、M1 bigram 索引全靠它。2026-09-07 补（首版漏了）。
        payload: { wiki_id: c.record.wiki_id, path: c.record.path, title: c.record.title, section: c.record.section, url: c.record.url, commit_sha: c.record.commit_sha, chunk_index: c.record.chunk_index, updated_at: c.record.updated_at, text: c.text },
      }))
      await upsertPoints(cfg.qdrantUrl, cfg.qdrantKey, collectionName, points, args.fetchImpl)
      // 写 checkpoint
      for (const p of points) await appendCheckpoint(args.stateDir, wiki.id, p.id)
      pointsUpserted += points.length
      idx += args.batchSize
      if ((idx / args.batchSize) % 10 === 0) console.log(`  · 已嵌入 ${idx}/${toEmbed.length}`)
    }

    console.log(`  · upsert ${pointsUpserted} points`)
    results.push({ wiki_id: wiki.id, repo: wiki.repo, branch, content_dir: contentDir, files: fileCount, chunks, tokens, pointsUpserted, skipped, durationMs })
    totalChunks += chunks
    totalTokens += tokens
  }

  return { results, totals: { chunks: totalChunks, tokens: totalTokens } }
}

// ── 本地 CLI 入口（tsx 直接运行）──
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    console.log(`用法：tsx scripts/one-shot-import.ts [选项]
  --dry-run              只数 chunks/token，不调任何 API（无需真实 key）
  --only=<wiki_id>       只跑单库（mtf-wiki|ftm-wiki|rle-wiki|miomtfwiki）
  --resume               断点续跑（跳过 checkpoint 已处理的 chunk）
  --local-dir=<path>     用本地目录作为 repo 根（dry-run 演示 / 离线测试；脚本再按 content_dir 取子集）
  --batch-size=N         embedBatch 每批条数（默认 32）
  --max-retries=N        429/5xx 退避重试上限（默认 6）
  --state-dir=<dir>      checkpoint JSONL 目录（默认 .ingest）
环境变量：QDRANT_URL / QDRANT_API_KEY / SILICONFLOW_API_KEY（--dry-run 可省略）`)
    return
  }
  const args: CliArgs = {
    dryRun: parsed.dryRun ?? false,
    only: parsed.only ?? null,
    resume: parsed.resume ?? false,
    localDir: parsed.localDir ?? null,
    chunkMaxChars: 1200,
    chunkOverlap: 150,
    batchSize: parsed.batchSize ?? 32,
    maxRetries: parsed.maxRetries ?? 6,
    stateDir: parsed.stateDir ?? ".ingest",
    fetchImpl: fetch,
  }
  const { results, totals } = await runImport(args, process.env)
  console.log(`\n${"=".repeat(50)}`)
  console.log(`总计：${results.length} 库  chunks=${totals.chunks}  token粗估=${totals.tokens}`)
  for (const r of results) {
    console.log(`  [${r.wiki_id}] ${r.repo}@${r.branch}  files=${r.files} chunks=${r.chunks} tokens=${r.tokens} upsert=${r.pointsUpserted} (${(r.durationMs / 1000).toFixed(1)}s)`)
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop() ?? "")) {
  main().catch((e) => {
    console.error(`\n[one-shot-import] 失败：${(e as Error).message ?? String(e)}`)
    process.exit(1)
  })
}
