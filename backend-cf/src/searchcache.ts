// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — backend-cf 短期结果缓存 (plan.md §5.2 / tasks.md T1.2)
// 缓存语义：
//   - 只缓存「纯向量阶段」的产物（向量初排的 hit 列表 + searchMs），rerank/LLM 一律每次重算 → 不串味；
//   - key = 归一化 query + corpora(排序) + top_k（用户 T1.2 约定）；TTL 1h；
//   - 命中时 timings.cached=true，跳过 embed + Qdrant（rerank 仍重算）；
//   - KV 用 Cloudflare KVNamespace 或测试注入的 CacheStore（接口与 KVNamespace 对齐，便于 mock）。
// KV/失败都不阻断搜索：缓存读写抛错一律吞掉，退回未缓存路径（cache 是锦上添花，不是可用性依赖）。
import type { SearchHit } from "./types"

/** 结果缓存的最小契约。KVNamespace 与测试 mock 都可满足；测试注入内存实现。 */
export interface CacheStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlSeconds: number): Promise<void>
}

/** 纯向量阶段缓存的载荷。rerank 始终重算，不入缓存。 */
export interface VectorStageCache {
  hits: SearchHit[] // 向量初排（未截断，供 rerank 直接用）
  searchMs: number
}

/** KVNamespace 适配成 CacheStore（生产路径用）。 */
export function kvCache(kv: KVNamespace): CacheStore {
  return {
    async get(k) {
      return kv.get(k)
    },
    async put(k, v, ttlSeconds) {
      await kv.put(k, v, { expirationTtl: ttlSeconds })
    },
  }
}

/** 查询归一化：trim + 小写 + 空白折叠 + NFC 正规化（避免同义全角/半角空格造成缓存 miss）。 */
export function normalizeQuery(q: string): string {
  return q
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
}

/** 构造缓存 key：query|corpora(排序,逗号)|top_k。corpora 排序保证多选顺序不影响命中。 */
export function buildCacheKey(query: string, corpora: readonly string[], topK: number): string {
  const sorted = [...corpora].sort().join(",")
  return `vec:${normalizeQuery(query)}|${sorted}|${topK}`
}

/** 从缓存取纯向量阶段结果；无值/损坏/异常一律返回 null（不阻断搜索）。 */
export async function cacheGetVectorStage(
  cache: CacheStore | undefined,
  key: string,
): Promise<VectorStageCache | null> {
  if (!cache) return null
  try {
    const raw = await cache.get(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as VectorStageCache
    if (!Array.isArray(parsed.hits)) return null
    if (typeof parsed.searchMs !== "number") return null
    return parsed
  } catch {
    return null
  }
}

/** 写入纯向量阶段结果到缓存。失败吞掉。 */
export async function cachePutVectorStage(
  cache: CacheStore | undefined,
  key: string,
  value: VectorStageCache,
  ttlSeconds = 3600, // 1h（T1.2）
): Promise<void> {
  if (!cache) return
  try {
    await cache.put(key, JSON.stringify(value), ttlSeconds)
  } catch {
    // KV 失败不影响结果
  }
}