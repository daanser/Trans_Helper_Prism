// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — ingest parser (tasks.md T0.3 / plan.md §7)
// 旧 script/indexer.py 的 frontmatter 解析 + body 清洗 + _index.md 目录元映射逻辑，
// 用 TypeScript 重写为纯函数模块（绝不调网络、绝不碰 IO）。
// 所有函数均为纯字符串/结构运算，可在 Workers 以外用 vitest 单测（plan.md §7.4.5）。
import { createHash } from "node:crypto"

/** frontmatter 值：标量字符串或简单字符串列表。 */
export type MetaValue = string | string[]
/** 解析后的 frontmatter 元数据。 */
export type FrontmatterMeta = Record<string, MetaValue>

export interface ParseResult {
  /** 解析出的 frontmatter key/value（若无 frontmatter 则为空对象）。 */
  meta: FrontmatterMeta
  /** 去掉 frontmatter 后的正文（已 trim）。 */
  body: string
}

/** 一个原始文件（repo-relative path + 内容），供 buildDirMeta/目录映射使用。 */
export interface RawFile {
  /** repo 相对路径（已去掉 content_dir 前缀即可），POSIX 分隔。 */
  path: string
  content: string
}

/** 解析 frontmatter。支持：无 frontmatter、`---` 包裹、key: value、简单 `[a, b]` 列表、引号剥离。 */
export function parseFrontmatter(text: string): ParseResult {
  if (!text.startsWith("---")) return { meta: {}, body: text.trim() }
  // 找到行首的结束分隔符 `---`（排除起始的三个 `---`）。
  const end = text.indexOf("\n---", 3)
  if (end === -1) return { meta: {}, body: text.trim() }

  const fmText = text.slice(3, end).trim()
  let body = text.slice(end + 4).trim()
  const meta: FrontmatterMeta = {}

  for (const line of fmText.split(/\r?\n/)) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    // 去掉一对引号（单引号或双引号）。
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim()
    }
    // 简单列表：`[a, b, c]`
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1)
      const list = inner
        .split(",")
        .map((s) => s.trim())
        .map((s) => (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1).trim() : s)
        .filter(Boolean)
      meta[key] = list
    } else {
      meta[key] = value
    }
  }
  return { meta, body }
}

/** 去掉 Hugo shortcodes（{{< >}} / {{% %}}）、HTML 注释，并合并连续 3+ 个空行成 2 个。 */
export function cleanBody(text: string): string {
  let out = text
  // Hugo shortcode：{{< ... >}} 与 {{% ... %}}（跨行）
  out = out.replace(/\{\{[<%][\s\S]*?[>%]\}\}/g, "")
  // HTML 注释：<!-- ... -->
  out = out.replace(/<!--[\s\S]*?-->/g, "")
  // 合并多余空行：3 个及以上换行 -> 2 个
  out = out.replace(/\n{3,}/g, "\n\n")
  return out.trim()
}

/**
 * 递归扫描所有 `_index.md`，建立 目录相对路径 -> {title,...meta} 的映射。
 * 与旧 build_dir_meta 一致：rel 为相对 content_dir 的路径（根为 ""）。
 * 这里接收一组"已读出的文件"，避免 parser 接触文件系统/网络；由调用方（导入脚本）喂入。
 */
export function buildDirMeta(files: ReadonlyArray<{ path: string; content: string }>): Record<string, FrontmatterMeta> {
  const dirMeta: Record<string, FrontmatterMeta> = {}
  for (const f of files) {
    const base = f.path.split("/").pop() ?? f.path
    if (base === "_index.md") {
      const folder = f.path.endsWith("/_index.md") ? f.path.slice(0, -"/_index.md".length) : ""
      const { meta } = parseFrontmatter(f.content)
      dirMeta[folder] = meta
    }
  }
  return dirMeta
}

/** 取某目录的 title（来自 _index.md），没有则用文件夹英文名。 */
export function folderTitle(folderRel: string, folderName: string, dirMeta: Record<string, FrontmatterMeta>): string {
  const m = dirMeta[folderRel]
  const t = m ? m.title : undefined
  return String(t ?? folderName).trim()
}

export interface PathMeta {
  category: string | null
  chapter: string | null
}

/**
 * 由文件相对路径 + _index.md 映射，解析出 category / chapter。
 * 继承旧 resolve_path_meta 语义：顶层文件夹取 _index.md title 即 category，
 * 深度>1 的文件夹若存在 _index.md，则其 title 拼入 chapter 链。
 */
export function resolvePathMeta(
  relPath: string,
  dirMeta: Record<string, FrontmatterMeta>,
  defaultCat?: string | null,
): PathMeta {
  const parts = relPath.split("/").filter(Boolean)
  const folders = parts.slice(0, -1) // 去掉文件名本身
  if (folders.length === 0) return { category: defaultCat ?? null, chapter: null }

  const catRel = folders[0]
  const category = defaultCat || folderTitle(catRel, folders[0], dirMeta)

  if (folders.length === 1) return { category, chapter: null }

  const chapterParts: string[] = []
  for (let depth = 1; depth < folders.length; depth++) {
    const rel = folders.slice(0, depth + 1).join("/")
    if (dirMeta[rel]) {
      chapterParts.push(folderTitle(rel, folders[depth], dirMeta))
    }
  }
  return { category, chapter: chapterParts.length > 0 ? chapterParts.join("/") : null }
}

/** 分块配置。 */
export interface ChunkOptions {
  /** 单块最大字符数。默认 1200。 */
  maxChars?: number
  /** 相邻块重叠字符数。默认 150。 */
  overlap?: number
  /** 作为章节分隔的标题级别集合。默认 [1,2,3,4]（h1–h4 断节，尽量保持语义完整）。 */
  sectionLevels?: number[]
  /** 正文长度低于此值即跳过（无意义的目录页/空页）。默认 50。 */
  minLen?: number
  /** 是否把章节标题文本并入 chunk 内容（默认 true，保留标题上下文）。 */
  includeHeading?: boolean
}

/** chunkMarkdown 的输入：解析好标题/章节/URL 等元数据 + 已清洗正文。 */
export interface ChunkInput {
  wiki_id: string
  /** repo 相对路径（已去掉 content_dir 前缀）。 */
  path: string
  /** 文章标题（来自 frontmatter title/name 或文件名 rule）。 */
  title: string
  /** 已解析的 category/chapter（来自 _index.md 映射）。 */
  section: PathMeta
  /** 已清洗的正文。 */
  body: string
  /** 原文 URL（可由调用方按 site_url + path 拼好）。 */
  url: string
  commit_sha: string
  /** 更新时间（ISO 字符串）。 */
  updated_at: string
}

/** 输出 chunk 记录字段（plan.md §7.3）。 */
export interface ChunkRecord {
  wiki_id: string
  path: string
  title: string
  section: string
  url: string
  commit_sha: string
  chunk_index: number
  updated_at: string
}

/** 按标题级别把正文切成若干"章节块"。每个块带标题链（用于 section 聚合）。 */
interface SectionBlock {
  level: number
  heading: string
  content: string
}

function splitByHeadings(body: string, sectionLevels: number[]): SectionBlock[] {
  const accepted = new Set(sectionLevels)
  const blocks: SectionBlock[] = []
  const lines = body.split(/\r?\n/)
  let current: SectionBlock = { level: 0, heading: "", content: "" }

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m && accepted.has(m[1].length)) {
      // 遇到可断节的标题：先把上一个块收尾
      blocks.push(current)
      current = { level: m[1].length, heading: m[2].trim(), content: "" }
    } else {
      current.content += (current.content ? "\n" : "") + line
    }
  }
  blocks.push(current)
  return blocks
}

/** 把一段超长文本切成带 overlap 的窗口。 */
function splitWindow(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text]
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length)
    out.push(text.slice(start, end))
    if (end === text.length) break
    start = Math.max(0, end - overlap)
  }
  return out
}

/** 由 section 的 category/chapter + 文件内标题链，拼成最终 section 字段。 */
function buildSection(base: PathMeta, headingChain: string[]): string {
  const parts: string[] = []
  if (base.category) parts.push(base.category)
  if (base.chapter) parts.push(base.chapter)
  parts.push(...headingChain)
  return parts.filter(Boolean).join(" / ")
}

/**
 * 按标题分级 + 贪心合并 + 字符窗口（maxChars + overlap）把文章切成 chunk 记录 + 对应文本。
 * 贪心合并：短章节（标题后跟少量正文）会与相邻章节合并，直到接近 maxChars 才切块，
 *   避免每个标题都产出一个 ~100 字符的碎片（MtF 等重度分节文档的坑）。
 *   只有单个章节本身超过 maxChars 时，才用 overlap 窗口切块。
 * title/section 取该 chunk 起始章节的标题链；overlap 窗口只在超长单章节内部生效。
 */
export function chunkMarkdownWithText(
  input: ChunkInput,
  opts: ChunkOptions = {},
): Array<{ record: ChunkRecord; text: string }> {
  const maxChars = opts.maxChars ?? 1200
  const overlap = opts.overlap ?? 150
  const sectionLevels = opts.sectionLevels ?? [1, 2, 3, 4]
  const minLen = opts.minLen ?? 50
  const includeHeading = opts.includeHeading ?? true

  if (input.body.length < minLen) return []

  const blocks = splitByHeadings(input.body, sectionLevels)

  // 每个标题块转成一个可合并的"单元"：携带其文本、章节链与标题。
  const stack: { level: number; text: string }[] = []
  const units: Array<{ text: string; title: string; section: string }> = []

  for (const block of blocks) {
    if (block.level === 0) {
      // 起始正文（文件开头、无标题）
      const text = includeHeading && block.heading ? block.heading + "\n\n" + block.content : block.content
      const section = buildSection(input.section, [])
      units.push({ text, title: input.title, section })
      continue
    }
    // 维护章节栈：pop 掉 level >= 当前 level 的，再 push 当前
    while (stack.length > 0 && stack[stack.length - 1].level >= block.level) stack.pop()
    stack.push({ level: block.level, text: block.heading })
    const headingChain = stack.map((s) => s.text)
    const text = includeHeading ? block.heading + "\n\n" + block.content : block.content
    units.push({ text, title: block.heading || input.title, section: buildSection(input.section, headingChain) })
  }

  const out: Array<{ record: ChunkRecord; text: string }> = []
  let chunkIndex = 0

  const pushChunk = (chunkText: string, title: string, section: string): void => {
    if (!chunkText.trim()) return
    const pieces = splitWindow(chunkText, maxChars, overlap)
    for (let i = 0; i < pieces.length; i++) {
      out.push({
        record: {
          wiki_id: input.wiki_id,
          path: input.path,
          title,
          section,
          url: input.url,
          commit_sha: input.commit_sha,
          chunk_index: chunkIndex++,
          updated_at: input.updated_at,
        },
        text: pieces[i],
      })
    }
  }

  // 贪心合并：把文本塞进当前缓冲，直到再塞下一个单元会超 maxChars 就落成一个 chunk。
  let buffer: string[] = []
  let bufLen = 0
  let bufTitle = input.title
  let bufSection = ""
  const flush = (): void => {
    if (buffer.length > 0) {
      pushChunk(buffer.join("\n"), bufTitle, bufSection)
      buffer = []
      bufLen = 0
    }
  }

  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    if (!u.text.trim()) continue // 纯把标题/空章节合并进去后已无独立文本，跳过碎片单元
    if (bufLen === 0) {
      // 起始缓冲
      buffer = [u.text]
      bufLen = u.text.length
      bufTitle = u.title
      bufSection = u.section
      continue
    }
    // 单章节本身超长：先落当前缓冲，再单独切这一单元
    if (u.text.length > maxChars) {
      flush()
      pushChunk(u.text, u.title, u.section)
      bufLen = 0
      buffer = []
      continue
    }
    // 加上下一个单元会超 maxChars：先落当前缓冲，再以此单元开启新缓冲
    if (bufLen + u.text.length > maxChars) {
      flush()
      buffer = [u.text]
      bufLen = u.text.length
      bufTitle = u.title
      bufSection = u.section
    } else {
      buffer.push(u.text)
      bufLen += u.text.length
    }
  }
  flush()

  return out
}

/** 只返回字段精确的 chunk 记录（不含正文）。 */
export function chunkMarkdown(input: ChunkInput, opts: ChunkOptions = {}): ChunkRecord[] {
  return chunkMarkdownWithText(input, opts).map((x) => x.record)
}

/** 计算 point id：sha1(wiki_id:path:chunk_index)，返回 Qdrant 兼容的 UUID 形（由 sha1 hex 前 128 位格式化）。 */
export function pointId(wiki_id: string, path: string, chunk_index: number): string {
  const h = createHash("sha1").update(`${wiki_id}:${path}:${chunk_index}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
