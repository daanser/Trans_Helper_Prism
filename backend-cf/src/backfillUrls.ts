// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 存量数据 url 回填（只改 Qdrant payload，不重新 embed）
//
// 背景：向量与文本已在库，仅 payload.url 仍是旧的 GitHub blob 链接。改用各 wiki 官网 URL
// 只需重写该字段——**不需要重新 ingest**（那要下载整仓 tarball + gunzip + 重新 embed，
// 在 Cloudflare 免费版（CPU 10ms / 内存 128MB / 50 子请求）里必然 exceededMemory/exceededCpu）。
//
// 本模块零 embedding、零 gunzip：scroll 读点 → 按路径重算官网 url → set payload 批量写回。
// 仅 FTM（Hugo）需要 frontmatter 的 slug，按唯一路径逐个 raw 拉取。
//
// 免费版单次最多 50 个子请求，故**按页处理**：每次调用处理一页 point，返回 next_offset 供续跑。

import { getWiki, collectionName } from "./wiki_registry"
import { buildSiteUrl } from "./wikiUrl"
import { parseFrontmatter } from "./ingest/parser"
import { fetchRawFile } from "./ingest/github"
import type { Env } from "./types"

/** 回填一页的结果摘要。 */
export interface BackfillResult {
  wiki_id: string
  collection: string
  /** 本页读到的 point 数。 */
  scanned: number
  /** 本页实际改写了 url 的 point 数。 */
  updated: number
  /** 本页已正确/无法处理而跳过的 point 数。 */
  skipped: number
  /** 本页 set payload 请求次数。 */
  payload_requests: number
  /** 下一页 scroll offset；null 表示已到末页（done=true）。 */
  next_offset: string | number | null
  /** 是否已处理完整个 collection。 */
  done: boolean
  /** 非致命错误（最多保留 20 条）。 */
  errors: string[]
}

interface ScrollPoint {
  id: string | number
  payload?: Record<string, unknown> | null
}

/** 单页默认点数：保证 1 scroll + 约 20 set 远低于 50 子请求上限。 */
const DEFAULT_PAGE = 100
const MAX_ERRORS = 20

/** scroll 一页（带 payload），返回点与下一页 offset。 */
async function scrollPage(
  collection: string,
  qdrantUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  limit: number,
  offset: unknown,
): Promise<{ points: ScrollPoint[]; next: string | number | null }> {
  const base = qdrantUrl.replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["api-key"] = apiKey

  const body: Record<string, unknown> = { limit, with_payload: true, with_vector: false }
  if (offset !== undefined && offset !== null) body.offset = offset

  const resp = await fetchImpl(`${base}/collections/${collection}/points/scroll`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`qdrant-scroll-failed status=${resp.status}`)
  const j = (await resp.json()) as { result?: { points?: ScrollPoint[]; next_page_offset?: unknown } }
  const next = j.result?.next_page_offset
  return {
    points: j.result?.points ?? [],
    next: next === null || next === undefined ? null : (next as string | number),
  }
}

/** 批量 set payload（同一 payload 作用于这批 id）。 */
async function setPayload(
  collection: string,
  qdrantUrl: string,
  apiKey: string | undefined,
  ids: Array<string | number>,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const base = qdrantUrl.replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["api-key"] = apiKey
  const resp = await fetchImpl(`${base}/collections/${collection}/points/payload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ payload, points: ids }),
  })
  if (!resp.ok) throw new Error(`qdrant-set-payload-failed status=${resp.status}`)
}

/** 该 wiki 是否依赖 frontmatter（slug）来生成 URL——目前仅 FTM（Hugo）。 */
function needsFrontmatter(wikiId: string): boolean {
  return wikiId === "ftm-wiki"
}

/**
 * 回填一个 wiki 的**一页** point 的 payload.url 为官网 URL。
 * - 幂等：已是官网 URL 的点跳过。
 * - 分页：返回 next_offset，调用方带上它继续；done=true 表示已处理完。
 * - FTM：按唯一路径拉取 raw 文件解析 slug（失败则该文件保持旧 url，记 errors）。
 */
export async function backfillWikiUrls(
  env: Env,
  wikiId: string,
  opts: { fetchImpl?: typeof fetch; offset?: string | number; pageSize?: number } = {},
): Promise<BackfillResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const wiki = getWiki(wikiId)
  if (!wiki) throw new Error(`unknown-wiki:${wikiId}`)
  if (!env.QDRANT_URL) throw new Error("qdrant-unconfigured")

  const collection = collectionName(wikiId)
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, 500) : DEFAULT_PAGE
  const { points, next } = await scrollPage(
    collection,
    env.QDRANT_URL,
    env.QDRANT_API_KEY,
    fetchImpl,
    pageSize,
    opts.offset,
  )

  const contentDir = wiki.content_dir.replace(/^\/+|\/+$/g, "")
  const prefix = contentDir ? `${contentDir}/` : ""
  const relOf = (repoRootPath: string): string =>
    repoRootPath.startsWith(prefix) ? repoRootPath.slice(prefix.length) : repoRootPath

  const errors: string[] = []
  const pushErr = (m: string) => {
    if (errors.length < MAX_ERRORS) errors.push(m)
  }
  const metaCache = new Map<string, Record<string, unknown>>()

  const metaFor = async (repoRootPath: string): Promise<Record<string, unknown> | undefined> => {
    const cached = metaCache.get(repoRootPath)
    if (cached) return cached
    try {
      const text = await fetchRawFile(wiki.repo, wiki.branch, repoRootPath, fetchImpl)
      const { meta } = parseFrontmatter(text)
      metaCache.set(repoRootPath, meta as Record<string, unknown>)
      return meta as Record<string, unknown>
    } catch (e) {
      pushErr(`${repoRootPath}: ${(e as Error)?.message ?? "raw-fetch-failed"}`)
      return undefined
    }
  }

  // 按「新 url」分组收集 id：同一文件的多个 chunk 共享同一 url，一次 set payload 批量写。
  const byUrl = new Map<string, Array<string | number>>()
  let skipped = 0

  for (const p of points) {
    const payload = (p.payload ?? {}) as Record<string, unknown>
    const repoRootPath = typeof payload.path === "string" ? payload.path : ""
    if (!repoRootPath) {
      skipped++
      continue
    }
    let meta: Record<string, unknown> | undefined
    if (needsFrontmatter(wikiId)) {
      meta = await metaFor(repoRootPath)
      if (!meta) {
        skipped++ // 拿不到 frontmatter：保持旧 url，不改
        continue
      }
    }
    const url = buildSiteUrl(wikiId, { repoRootPath, contentDirRel: relOf(repoRootPath), meta })
    if (url === payload.url) {
      skipped++
      continue
    }
    const arr = byUrl.get(url) ?? []
    arr.push(p.id)
    byUrl.set(url, arr)
  }

  let updated = 0
  let payloadRequests = 0
  for (const [url, ids] of byUrl) {
    for (let i = 0; i < ids.length; i += pageSize) {
      const batch = ids.slice(i, i + pageSize)
      try {
        await setPayload(collection, env.QDRANT_URL, env.QDRANT_API_KEY, batch, { url }, fetchImpl)
        payloadRequests++
        updated += batch.length
      } catch (e) {
        pushErr(`set-payload: ${(e as Error)?.message ?? "failed"}`)
      }
    }
  }

  return {
    wiki_id: wikiId,
    collection,
    scanned: points.length,
    updated,
    skipped,
    payload_requests: payloadRequests,
    next_offset: next,
    done: next === null,
    errors,
  }
}
