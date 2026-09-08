// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 知识树数据层 (tasks.md T2.4 / plan.md §2.4)
// 树的数据源 = Qdrant collection 的 chunk payload，不另维护树表。
//  - fetchAllChunks：Qdrant REST scroll 分页拉全量 point 的 payload（只取 title/section_path/path/url/updated_at）。
//  - buildTree：按 section_path（'/' 分段）把 chunk 聚合为层级树节点（标题/子章节/篇数/最新更新时间）。
// 模块只定义数据层与类型；GET /api/v1/tree/{wiki_id} 路由由下一波接入。

/** 一条精简后的 chunk 元数据（scroll 抽取所需字段）。 */
export interface ChunkRecord {
  title: string
  sectionPath: string
  path: string
  url: string
  updatedAt: string | number | null
}

/** 知识树的一个节点。docCount = 该节点及其所有后代下的文档总数；updatedAt = 该节点子树内最新更新时间。 */
export interface TreeSection {
  title: string
  children: TreeSection[]
  docCount: number
  updatedAt: string | number | null
}

/** scroll 分页返回的单个 point（只读所需字段）。 */
interface ScrollPoint {
  payload?: Record<string, unknown> | null
}

/** 拉取 chunk 全量失败（含 404 库不存在 / 非 2xx）。 */
export class QdrantScrollError extends Error {
  readonly status: number
  readonly collection: string
  constructor(collection: string, status: number, detail: string) {
    super(`qdrant-scroll-failed collection=${collection} status=${status} ${detail}`)
    this.collection = collection
    this.status = status
  }
}

/** 精简字符串字段（非字符串统一回空串）。 */
function s(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/** 归一化 updated_at 为可比较数字；无法归一化（NaN）视作永不最新。 */
function normalizable(v: string | number): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : -Infinity
}

/** 取 a/b 中"时间较新"（保留原始形式）者；null 视为缺失永不占优。 */
function latestTime(a: string | number | null, b: string | number | null): string | number | null {
  if (a === null) return b
  if (b === null) return a
  return normalizable(a) >= normalizable(b) ? a : b
}

/** 解析 payload 里的 updated_at：数字原样保留，非空字符串保留，其余 null。 */
function parseUpdatedAt(v: unknown): string | number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v !== "") return v
  return null
}

/**
 * 用 Qdrant REST scroll 分页拉取一个 collection 的全量 point payload，抽取成精简 chunk 元数据。
 * - 循环 POST /collections/{collection}/points/scroll，body { limit, with_payload: true, offset }，
 *   直到响应 result.next_page_offset 为 null / undefined。
 * - 只取 title / section_path / path / url / updated_at 字段。
 * - 非 2xx 抛 QdrantScrollError。
 * @param fetchImpl 可注入的 fetch（测试全 mock）；缺省用全局 fetch。
 */
export async function fetchAllChunks(
  collection: string,
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  limit = 500,
  maxPages = 200,
): Promise<ChunkRecord[]> {
  const base = baseUrl.replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["api-key"] = apiKey

  const chunks: ChunkRecord[] = []
  let offset: unknown = null
  let page = 0
  for (;;) {
    // 防呆：异常 Qdrant 若一直回传非空 next_page_offset，会死循环。超过上限直接停。
    if (page >= maxPages) break
    page++
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        limit,
        with_payload: true,
        ...(offset !== null && offset !== undefined ? { offset } : {}),
      }),
    }
    const resp = await fetchImpl(`${base}/collections/${collection}/points/scroll`, init)
    if (!resp.ok) {
      throw new QdrantScrollError(collection, resp.status, "")
    }
    const data = (await resp.json()) as unknown
    const result = (data as { result?: { points?: ScrollPoint[]; next_page_offset?: unknown } })?.result
    for (const p of result?.points ?? []) {
      const payload = (p.payload ?? {}) as Record<string, unknown>
      chunks.push({
        title: s(payload.title),
        sectionPath: s(payload.section_path),
        path: s(payload.path),
        url: s(payload.url),
        updatedAt: parseUpdatedAt(payload.updated_at),
      })
    }
    const next = result?.next_page_offset
    if (next === null || next === undefined) break
    offset = next
  }
  return chunks
}

/**
 * 内部累加节点：在输出字段基础上带按 title 索引的子节点映射（O(1) 查找/去重）。
 * builtTree 用 title="" 的虚拟根统一挂载所有顶层章节，避免根/叶类型分裂。
 */
interface AccNode {
  title: string
  children: AccNode[]
  docCount: number
  updatedAt: string | number | null
  byTitle: Map<string, AccNode>
}

function makeNode(title: string): AccNode {
  return { title, children: [], docCount: 0, updatedAt: null, byTitle: new Map() }
}

/** 去掉累加用索引，还原为纯 TreeSection（供返回）。 */
function toSection(node: AccNode): TreeSection {
  return {
    title: node.title,
    children: node.children.map(toSection),
    docCount: node.docCount,
    updatedAt: node.updatedAt,
  }
}

/**
 * 按 section_path（'/' 分段）把 chunk 聚合为层级知识树。
 * - 每个节点 docCount = 该节点及其后代下的文档总数；updatedAt = 该节点子树内最新更新时间。
 * - 沿根到叶子每条路径逐层累加，因此乱序输入、深层路径均正确。
 * - 空 section_path 的 chunk 无处可挂，跳过。
 * - 空输入返回空数组。
 */
export function buildTree(chunks: ChunkRecord[]): TreeSection[] {
  const root = makeNode("")
  for (const chunk of chunks) {
    const segments = chunk.sectionPath
      .split("/")
      .map((seg) => seg.trim())
      .filter((seg) => seg.length > 0)
    if (segments.length === 0) continue
    let level = root
    for (const seg of segments) {
      let node = level.byTitle.get(seg)
      if (!node) {
        node = makeNode(seg)
        level.byTitle.set(seg, node)
        level.children.push(node)
      }
      node.docCount += 1
      node.updatedAt = latestTime(node.updatedAt, chunk.updatedAt)
      level = node
    }
  }
  return root.children.map(toSection)
}