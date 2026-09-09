// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 存量数据 url 回填（只改 Qdrant payload，不重新 embed）
//
// 背景：向量与文本已在库，仅 payload.url 仍是旧的 GitHub blob 链接。改用各 wiki 官网 URL
// 只需重写该字段——**不需要重新 ingest**（那要下载整仓 tarball + gunzip + 重新 embed，
// 在 Cloudflare 免费版（CPU 10ms / 内存 128MB / 50 子请求）里必然 exceededMemory/exceededCpu）。
//
// 本模块零 embedding、零 gunzip：scroll 读点 → 按路径重算官网 url → set payload 批量写回。
// 仅 FTM（Hugo）需要 frontmatter 的 slug，按唯一路径逐个 raw 拉取（通常十几个文件，远低于子请求上限）。

import { getWiki, collectionName } from "./wiki_registry"
import { buildSiteUrl } from "./wikiUrl"
import { parseFrontmatter } from "./ingest/parser"
import { fetchRawFile } from "./ingest/github"
import type { Env } from "./types"

/** 回填一次的结果摘要（供 admin 端点返回 / 单测断言）。 */
export interface BackfillResult {
  wiki_id: string
  collection: string
  /** scroll 到的 point 总数。 */
  scanned: number
  /** 实际改写了 url 的 point 数。 */
  updated: number
  /** 已正确、跳过的 point 数。 */
  skipped: number
  /** set payload 请求次数。 */
  payload_requests: number
  /** 非致命的逐文件错误（该文件保持旧 url）。 */
  errors: string[]
}

interface ScrollPoint {
  id: string | number
  payload?: Record<string, unknown> | null
}

/** 每页 scroll 条数（也是 set payload 每批上限）。 */
const PAGE = 100

/** scroll 整个 collection 的 point（id + payload）。超过 MAX_PAGES 页则抛错，避免失控循环。 */
async function scrollAll(
  collection: string,
  qdrantUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  maxPages = 100,
): Promise<ScrollPoint[]> {
  const base = qdrantUrl.replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["api-key"] = apiKey

  const out: ScrollPoint[] = []
  let offset: unknown = undefined
  for (let page = 0; page < maxPages; page++) {
    const resp = await fetchImpl(`${base}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers,
      body: JSON.stringify({ limit: PAGE, with_payload: true, with_vector: false, offset }),
    })
    if (!resp.ok) throw new Error(`qdrant-scroll-failed status=${resp.status}`)
    const j = (await resp.json()) as { result?: { points?: ScrollPoint[]; next_page_offset?: unknown } }
    out.push(...(j.result?.points ?? []))
    const next = j.result?.next_page_offset
    if (next === null || next === undefined) break
    offset = next
  }
  return out
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
 * 把一个 wiki 的全部 point 的 payload.url 回填成官网 URL。
 * - 幂等：已是官网 URL 的点跳过。
 * - FTM：按唯一路径拉取 raw 文件解析 slug（失败则该文件保持旧 url，记 errors）。
 */
export async function backfillWikiUrls(
  env: Env,
  wikiId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<BackfillResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const wiki = getWiki(wikiId)
  if (!wiki) throw new Error(`unknown-wiki:${wikiId}`)
  if (!env.QDRANT_URL) throw new Error("qdrant-unconfigured")

  const collection = collectionName(wikiId)
  const points = await scrollAll(collection, env.QDRANT_URL, env.QDRANT_API_KEY, fetchImpl)

  const contentDir = wiki.content_dir.replace(/^\/+|\/+$/g, "")
  const prefix = contentDir ? `${contentDir}/` : ""
  const relOf = (repoRootPath: string): string =>
    repoRootPath.startsWith(prefix) ? repoRootPath.slice(prefix.length) : repoRootPath

  const errors: string[] = []
  const metaCache = new Map<string, Record<string, unknown>>()

  /** FTM 专用：拿一个文件的 frontmatter（带缓存）。失败返回 undefined 并记 errors。 */
  const metaFor = async (repoRootPath: string): Promise<Record<string, unknown> | undefined> => {
    if (metaCache.has(repoRootPath)) return metaCache.get(repoRootPath)
    try {
      const text = await fetchRawFile(wiki.repo, wiki.branch, repoRootPath, fetchImpl)
      const { meta } = parseFrontmatter(text)
      metaCache.set(repoRootPath, meta as Record<string, unknown>)
      return meta as Record<string, unknown>
    } catch (e) {
      errors.push(`${repoRootPath}: ${(e as Error)?.message ?? "raw-fetch-failed"}`)
      return undefined
    }
  }

  // 按「新 url」分组收集 id：同一文件的多个 chunk 共享同一 url，一次 set payload 可批量写。
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
    for (let i = 0; i < ids.length; i += PAGE) {
      const batch = ids.slice(i, i + PAGE)
      try {
        await setPayload(collection, env.QDRANT_URL, env.QDRANT_API_KEY, batch, { url }, fetchImpl)
        payloadRequests++
        updated += batch.length
      } catch (e) {
        errors.push(`set-payload: ${(e as Error)?.message ?? "failed"}`)
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
    errors,
  }
}
