// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — searchcache.ts 单测 (tasks.md T1.2)
// 覆盖：key 构造（归一化/corpora 排序/top_k）、纯向量缓存读写、损坏缓存容错、失败吞掉。
import { describe, it, expect } from "vitest"
import {
  normalizeQuery,
  buildCacheKey,
  kvCache,
  cacheGetVectorStage,
  cachePutVectorStage,
  type CacheStore,
  type VectorStageCache,
} from "../src/searchcache"
import type { SearchHit } from "../src/types"

/** 内存 CacheStore（模拟 KVNamespace 语义）。 */
function memCache(): { store: CacheStore; data: Map<string, string>; puts: Array<{ k: string; ttl: number }> } {
  const data = new Map<string, string>()
  const puts: Array<{ k: string; ttl: number }> = []
  const store: CacheStore = {
    async get(k) {
      return data.get(k) ?? null
    },
    async put(k, v, ttlSeconds) {
      puts.push({ k, ttl: ttlSeconds })
      data.set(k, v)
    },
  }
  return { store, data, puts }
}

const hit = (id: string, score: number): SearchHit => ({
  id,
  title: `T${id}`,
  url: "u",
  source: "s",
  path: "p",
  snippet: "x",
  score,
})

describe("normalizeQuery / buildCacheKey", () => {
  it("归一化：trim、小写、空白折叠、NFC", () => {
    expect(normalizeQuery("  跨性别  激素  ")).toBe("跨性别 激素")
    expect(normalizeQuery("ABC")).toBe("abc")
  })

  it("key 随 corpora 顺序归一（排序），含 top_k", () => {
    const k1 = buildCacheKey("测试", ["mtf-wiki", "ftm-wiki"], 10)
    const k2 = buildCacheKey("测试", ["ftm-wiki", "mtf-wiki"], 10) // 顺序无关
    expect(k1).toBe(k2)
    expect(buildCacheKey("测试", ["mtf-wiki"], 5)).not.toBe(buildCacheKey("测试", ["mtf-wiki"], 10))
  })
})

describe("cacheGetVectorStage / cachePutVectorStage", () => {
  it("写后读回一致的向量初排结果", async () => {
    const { store } = memCache()
    const value: VectorStageCache = { hits: [hit("a", 0.9), hit("b", 0.8)], searchMs: 120 }
    await cachePutVectorStage(store, "vec:k", value, 3600)
    const got = await cacheGetVectorStage(store, "vec:k")
    expect(got).toEqual(value)
  })

  it("kvCache 写入带 expirationTtl（1h=3600s）", async () => {
    const { store, puts } = memCache()
    await cachePutVectorStage(store, "vec:k", { hits: [hit("a", 1)], searchMs: 1 }, 3600)
    expect(puts[0].ttl).toBe(3600)
  })

  it("未命中返回 null；损坏 JSON 返回 null 不抛错", async () => {
    const { store, data } = memCache()
    expect(await cacheGetVectorStage(store, "miss")).toBeNull()
    data.set("vec:bad", "{not-json")
    expect(await cacheGetVectorStage(store, "vec:bad")).toBeNull()
    data.set("vec:misshape", JSON.stringify({ hits: "nope" }))
    expect(await cacheGetVectorStage(store, "vec:misshape")).toBeNull()
  })

  it("cache 未提供（undefined）时读写均为安全 no-op", async () => {
    expect(await cacheGetVectorStage(undefined, "vec:k")).toBeNull()
    await expect(cachePutVectorStage(undefined, "vec:k", { hits: [], searchMs: 0 })).resolves.toBeUndefined()
  })

  it("kvCache 适配：get/put 委托给 KVNamespace（用内存实现验证接口形状）", async () => {
    const inner: CacheStore = memCache().store
    const wrapped = kvCache(inner as unknown as KVNamespace)
    await wrapped.put("k", "v", 60)
    expect(await wrapped.get("k")).toBe("v")
  })
})