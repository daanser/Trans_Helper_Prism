// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — search.ts 单测 (tasks.md T0.4)
// 全 mock global fetch，绝不调真实上游。覆盖：
//   1) 正常多库并行检索：合并去重（按 point id）+ 截断 top_k + timings/quota/warnings
//   2) 非法参数 → 422（经 Hono 路由 /api/v1/search）
//   3) embedding 抛错 → 自动 fallback（fallback:true，notice，hits 空）
//   4) use_reranker=false 物理跳过 rerank；use_reranker=true 走真 rerank（批量重排/裁剪/失败降级）
import { describe, it, expect, vi, beforeEach } from "vitest"
import { runSearch } from "../src/search"
import type { RunSearchResult } from "../src/search"
import type { FallbackResponse } from "../src/fallback"
import type { CacheStore } from "../src/searchcache"
import { app } from "../src/index"
import type { Env, SearchResponse } from "../src/types"

/** 判别 FallbackResponse 与 SearchResponse 的联合类型守卫。 */
function isFallback(res: RunSearchResult): res is FallbackResponse {
  return (res as FallbackResponse).fallback === true
}

/** 断言 res 是完整 SearchResponse（非 fallback），并断言类型化返回。 */
function asOk(res: RunSearchResult): SearchResponse {
  expect(isFallback(res)).toBe(false)
  return res as SearchResponse
}

/** 最小 Env：embed/llm pool 各一个 key + Qdrant 连接 + embedding 维度。 */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    EMBED_POOL_KEYS: "sk-embed-a",
    LLM_POOL_KEYS: "sk-llm-a", // rerank 并入 llm_pool
    QDRANT_URL: "https://qdrant.example",
    QDRANT_API_KEY: "qdrant-test-key",
    EMBEDDING_DIM: "1024",
    ...overrides,
  } as Env
}

/** 向量长度 1024（与 EMBEDDING_DIM 一致），避免 dim-mismatch。 */
function vec(len = 1024): number[] {
  return new Array(len).fill(0.1)
}

/** 可控时钟：每次读取递增 step 毫秒，让 timings 可观察地 >0（microtask mock 下真实时间恒为 0）。 */
function fakeClock(step = 1): () => number {
  let t = 0
  return () => (t += step)
}

/** 构造一个 /points/search 响应体。 */
function searchBody(points: Array<{ id: string; score: number; payload: Record<string, unknown> }>): string {
  return JSON.stringify({ result: points })
}

/**
 * 按 URL 路由的 fetch mock。
 * - /v1/embeddings → embed()（默认 200，返回 1024 维）
 * - /collections/{name}/points/search → search(collection, body)，记录到 searches
 */
function makeFetchMock(opts: {
  embed?: () => Promise<Response>
  search?: (collection: string, body: unknown) => Promise<Response>
  rerank?: (body: { query: string; documents: string[]; model?: string }) => Promise<Response>
}): {
  fetchImpl: typeof fetch
  searches: Array<{ collection: string; body: Record<string, unknown> }>
  reranks: Array<{ query: string; documents: string[]; model?: string }>
} {
  const searches: Array<{ collection: string; body: Record<string, unknown> }> = []
  const reranks: Array<{ query: string; documents: string[]; model?: string }> = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u.includes("/v1/embeddings")) {
      if (opts.embed) return opts.embed()
      return new Response(JSON.stringify({ data: [{ embedding: vec() }] }), { status: 200 })
    }
    if (u.includes("/v1/rerank")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; documents: string[]; model?: string }
      reranks.push(body)
      if (opts.rerank) return opts.rerank(body)
      // 默认：按原顺序给固定高分，保证"只重排不增删"的一致性可观察。
      const results = body.documents.map((_, i) => ({ index: i, relevance_score: 1 - i * 0.1 }))
      return new Response(JSON.stringify({ model: body.model, results }), { status: 200 })
    }
    const m = u.match(/\/collections\/([^/]+)\/points\/search$/)
    if (m) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      searches.push({ collection: m[1], body })
      if (opts.search) return opts.search(m[1], body)
      return new Response(JSON.stringify({ result: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: "unexpected-url" }), { status: 500 })
  }) as unknown as typeof fetch
  return { fetchImpl, searches, reranks }
}

/** 默认 embedding 抛错。 */
function failingEmbed(): Promise<Response> {
  return Promise.reject(new Error("embedding-upstream-down"))
}

describe("runSearch 正常链路", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("多库并行检索：合并去重（按 point id）+ 截断 top_k + timings", async () => {
    const env = makeEnv()
    const { fetchImpl, searches } = makeFetchMock({
      search: (collection) => {
        if (collection === "mtf_wiki_v1") {
          return Promise.resolve(
            new Response(
              searchBody([
                { id: "a", score: 0.9, payload: { title: "T1", url: "u1", source: "MtF Wiki", path: "p1", snippet: "s1" } },
                { id: "b", score: 0.8, payload: { title: "T2", url: "u2", source: "MtF Wiki", path: "p2", snippet: "s2" } },
                { id: "c", score: 0.7, payload: { title: "T3", url: "u3", source: "MtF Wiki", path: "p3", snippet: "s3" } },
              ]),
              { status: 200 },
            ),
          )
        }
        // ftm_wiki_v1
        return Promise.resolve(
          new Response(
            searchBody([
              // b 与 mtf 库重复（id 相同），score 更高 → 去重应保留更高分
              { id: "b", score: 0.85, payload: { title: "T2b", url: "u2b", source: "FtM Wiki", path: "p2b", snippet: "s2b" } },
              { id: "d", score: 0.6, payload: { title: "T4", url: "u4", source: "FtM Wiki", path: "p4", snippet: "s4" } },
              { id: "e", score: 0.5, payload: { title: "T5", url: "u5", source: "FtM Wiki", path: "p5", snippet: "s5" } },
            ]),
            { status: 200 },
          ),
        )
      },
    })

    // top_k=5，能看到全部合并结果，验证去重
    const res = await runSearch(
      { query: "测试", corpora: ["mtf-wiki", "ftm-wiki"], top_k: 5, use_reranker: false },
      env,
      { fetchImpl },
    )
    const ok = asOk(res)
    expect(ok.hits).toHaveLength(5) // a,b,c,d,e 共 5 个，b 被去重
    expect(ok.hits.map((h) => h.id)).toEqual(["a", "b", "c", "d", "e"]) // score 降序
    // 去重后 b 取更高分的那条（0.85，源自 ftm）
    const b = ok.hits.find((h) => h.id === "b")!
    expect(b.score).toBeCloseTo(0.85)
    expect(b.source).toBe("FtM Wiki")

    // 每库请求的 limit = top_k*3 = 15
    expect(searches).toHaveLength(2)
    expect(searches[0].collection).toBe("mtf_wiki_v1")
    expect(searches[0].body.limit).toBe(15)
    expect(searches[1].collection).toBe("ftm_wiki_v1")
    expect(searches[1].body.limit).toBe(15)
    // with_payload 必须为 true，才能拿到 title/url 等
    expect(searches[0].body.with_payload).toBe(true)

    // timings：rerank/llm 为 0，total = embed+search
    expect(ok.timings.rerank_ms).toBe(0)
    expect(ok.timings.llm_ms).toBe(0)
    expect(ok.timings.total_ms).toBe(ok.timings.embed_ms + ok.timings.search_ms)
    expect(ok.timings.embed_ms).toBeGreaterThanOrEqual(0)
    expect(ok.timings.search_ms).toBeGreaterThanOrEqual(0)
    // quota 占位：fallback 为 false，额度字段占位 0
    expect(ok.quota.fallback).toBe(false)
    // 无 rerank/llm 开关 → 无 warnings
    expect(ok.warnings).toEqual([])
  })

  it("多库并行检索：截断到 top_k", async () => {
    const env = makeEnv()
    const { fetchImpl } = makeFetchMock({
      search: () =>
        Promise.resolve(
          new Response(
            searchBody([
              { id: "a", score: 0.9, payload: { title: "A", url: "u", source: "MtF Wiki", path: "p", snippet: "s" } },
              { id: "b", score: 0.8, payload: { title: "B", url: "u", source: "MtF Wiki", path: "p", snippet: "s" } },
              { id: "c", score: 0.7, payload: { title: "C", url: "u", source: "MtF Wiki", path: "p", snippet: "s" } },
            ]),
            { status: 200 },
          ),
        ),
    })

    const res = await runSearch({ query: "测试", corpora: ["mtf-wiki"], top_k: 2, use_reranker: false }, env, { fetchImpl })
    const ok = asOk(res)
    expect(ok.hits).toHaveLength(2)
    expect(ok.hits.map((h) => h.id)).toEqual(["a", "b"])
  })
})

describe("runSearch 非法参数", () => {
  it("空 query → invalid-query", async () => {
    const env = makeEnv()
    const { fetchImpl } = makeFetchMock({})
    await expect(
      runSearch({ query: "   ", corpora: ["mtf-wiki"] }, env, { fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid-query" })
  })

  it("corpora 空或含非白名单值 → invalid-corpora", async () => {
    const env = makeEnv()
    const { fetchImpl } = makeFetchMock({})
    await expect(
      runSearch({ query: "x", corpora: [] }, env, { fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid-corpora" })
    await expect(
      runSearch({ query: "x", corpora: ["mtf-wiki", "not-a-wiki"] }, env, { fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid-corpora" })
  })

  it("top_k 越界 → invalid-top-k", async () => {
    const env = makeEnv()
    const { fetchImpl } = makeFetchMock({})
    await expect(
      runSearch({ query: "x", corpora: ["mtf-wiki"], top_k: 0 }, env, { fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid-top-k" })
    await expect(
      runSearch({ query: "x", corpora: ["mtf-wiki"], top_k: 31 }, env, { fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid-top-k" })
  })
})

describe("POST /api/v1/search 路由：非法参数 422", () => {
  it("缺 query / 非法 corpora / 越界 top_k 均返回 422", async () => {
    const env = makeEnv()
    const jsonHeaders: Record<string, string> = { "Content-Type": "application/json" }

    // 空 query
    let resp = await app.request(
      "/api/v1/search",
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ query: "", corpora: ["mtf-wiki"] }) },
      env,
    )
    expect(resp.status).toBe(422)
    expect(await resp.json()).toEqual({ error: "invalid-query" })

    // 空 corpora
    resp = await app.request(
      "/api/v1/search",
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ query: "x", corpora: [] }) },
      env,
    )
    expect(resp.status).toBe(422)
    expect(await resp.json()).toEqual({ error: "invalid-corpora" })

    // corpora 含非白名单库
    resp = await app.request(
      "/api/v1/search",
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ query: "x", corpora: ["evil"] }) },
      env,
    )
    expect(resp.status).toBe(422)
    expect(await resp.json()).toEqual({ error: "invalid-corpora" })

    // top_k 越界
    resp = await app.request(
      "/api/v1/search",
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ query: "x", corpora: ["mtf-wiki"], top_k: 40 }) },
      env,
    )
    expect(resp.status).toBe(422)
    expect(await resp.json()).toEqual({ error: "invalid-top-k" })
  })
})

describe("runSearch 上游失败 → fallback", () => {
  it("embedding 抛错自动切 fallback（fallback:true）", async () => {
    const env = makeEnv()
    const { fetchImpl } = makeFetchMock({ embed: failingEmbed })
    const res = await runSearch({ query: "测试", corpora: ["mtf-wiki"] }, env, { fetchImpl })

    expect(isFallback(res)).toBe(true)
    if (!isFallback(res)) return
    expect(res.hits).toEqual([])
    expect(res.notice).toContain("关键词模式")
  })

  it("Qdrant URL 未配置视为上游失败 → fallback", async () => {
    const env = makeEnv({ QDRANT_URL: undefined })
    const { fetchImpl } = makeFetchMock({})
    const res = await runSearch({ query: "测试", corpora: ["mtf-wiki"] }, env, { fetchImpl })
    expect(isFallback(res)).toBe(true)
  })
})

describe("runSearch 开启 rerank 开关", () => {
  it("use_reranker=false 物理跳过 rerank：无 rerank 调用、rerank_ms=0、结果按向量分排序", async () => {
    const env = makeEnv()
    const { fetchImpl, reranks } = makeFetchMock({
      search: () =>
        Promise.resolve(
          new Response(
            searchBody([
              { id: "a", score: 0.9, payload: { title: "A", url: "u", source: "MtF Wiki", path: "p", snippet: "sa" } },
              { id: "b", score: 0.8, payload: { title: "B", url: "u", source: "MtF Wiki", path: "p", snippet: "sb" } },
              { id: "c", score: 0.7, payload: { title: "C", url: "u", source: "MtF Wiki", path: "p", snippet: "sc" } },
            ]),
            { status: 200 },
          ),
        ),
    })
    const res = await runSearch({ query: "测试", corpora: ["mtf-wiki"], use_reranker: false, top_k: 3 }, env, { fetchImpl })
    const ok = asOk(res)
    expect(ok.hits.map((h) => h.id)).toEqual(["a", "b", "c"]) // 物理跳过 → 向量分序
    expect(reranks).toHaveLength(0) // 未触发上游调用
    expect(ok.timings.rerank_ms).toBe(0)
    expect(ok.warnings).toEqual([])
    expect(ok.hits.every((h) => h.rerank_score === undefined)).toBe(true)
  })

  it("use_reranker=true 走真 rerank：候选批量重排、rerank_ms>0、重排分降序、结果只重排不增删", async () => {
    const env = makeEnv()
    const { fetchImpl, reranks } = makeFetchMock({
      search: () =>
        Promise.resolve(
          new Response(
            searchBody([
              { id: "a", score: 0.7, payload: { title: "A", url: "u", source: "MtF Wiki", path: "p", snippet: "sa" } },
              { id: "b", score: 0.9, payload: { title: "B", url: "u", source: "MtF Wiki", path: "p", snippet: "sb" } },
              { id: "c", score: 0.8, payload: { title: "C", url: "u", source: "MtF Wiki", path: "p", snippet: "sc" } },
            ]),
            { status: 200 },
          ),
        ),
      // rerank 把向量分最低的 a 打到最高 —— 证明重排生效（向量序 b>c>a，重排后 a 最高）
      rerank: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: "BAAI/bge-reranker-v2-m3",
              results: [
                { index: 2, relevance_score: 0.99 }, // candidate[2]=a 打到最高
                { index: 0, relevance_score: 0.5 }, // candidate[0]=b
                { index: 1, relevance_score: 0.1 }, // candidate[1]=c
              ],
            }),
            { status: 200 },
          ),
        ),
    })
    const res = await runSearch(
      { query: "测试", corpora: ["mtf-wiki"], use_reranker: true, top_k: 3 },
      env,
      { fetchImpl, nowMs: fakeClock(1) }, // 可控时钟：让 rerank_ms 可观察地 >0
    )
    const ok = asOk(res)
    expect(reranks).toHaveLength(1)
    expect(reranks[0].documents).toHaveLength(3)
    // 候选进入 rerank 的是向量序合并后的 [b,c,a]；rerank 后按 relevance 降序 → [a,b,c]
    expect(ok.hits.map((h) => h.id)).toEqual(["a", "b", "c"])
    expect(ok.hits.map((h) => h.rerank_score)).toEqual([0.99, 0.5, 0.1])
    expect(ok.timings.rerank_ms).toBeGreaterThan(0)
    // 已实现真 rerank，不再有 reranker-not-yet warning
    expect(ok.warnings).not.toContain("reranker-not-yet")

    // 开 LLM 仍只带 llm-not-yet
    const resLlm = await runSearch(
      { query: "测试", corpora: ["mtf-wiki"], use_llm: true, top_k: 3 },
      env,
      { fetchImpl },
    )
    expect(asOk(resLlm).warnings).toContain("llm-not-yet")
  })

  it("rerank 候选裁剪：仅截取 rerankCandidateLimit 条（RERANK_TOP_K 可配置）", async () => {
    const env = makeEnv({ RERANK_TOP_K: "2" })
    const { fetchImpl, reranks } = makeFetchMock({
      search: () =>
        Promise.resolve(
          new Response(
            searchBody([
              { id: "a", score: 0.9, payload: { title: "A", url: "u", source: "MtF Wiki", path: "p", snippet: "sa" } },
              { id: "b", score: 0.8, payload: { title: "B", url: "u", source: "MtF Wiki", path: "p", snippet: "sb" } },
              { id: "c", score: 0.7, payload: { title: "C", url: "u", source: "MtF Wiki", path: "p", snippet: "sc" } },
            ]),
            { status: 200 },
          ),
        ),
    })
    const res = await runSearch({ query: "测试", corpora: ["mtf-wiki"], use_reranker: true, top_k: 2 }, env, { fetchImpl })
    asOk(res)
    expect(reranks).toHaveLength(1)
    expect(reranks[0].documents).toHaveLength(2) // 只取 top 2 候选
  })

  it("rerank 上游失败（超时/池全灭）→ 降级回向量序 + warnings:[\"rerank-fallback\"]", async () => {
    const env = makeEnv()
    const { fetchImpl, reranks } = makeFetchMock({
      search: () =>
        Promise.resolve(
          new Response(
            searchBody([
              { id: "a", score: 0.9, payload: { title: "A", url: "u", source: "MtF Wiki", path: "p", snippet: "sa" } },
              { id: "b", score: 0.8, payload: { title: "B", url: "u", source: "MtF Wiki", path: "p", snippet: "sb" } },
              { id: "c", score: 0.7, payload: { title: "C", url: "u", source: "MtF Wiki", path: "p", snippet: "sc" } },
            ]),
            { status: 200 },
          ),
        ),
      rerank: () => Promise.reject(new Error("rerank-upstream-down")),
    })
    const res = await runSearch(
      { query: "测试", corpora: ["mtf-wiki"], use_reranker: true, top_k: 3 },
      env,
      { fetchImpl },
    )
    const ok = asOk(res)
    // 降级：保持向量序，仍可返回结果
    expect(ok.hits.map((h) => h.id)).toEqual(["a", "b", "c"])
    expect(ok.warnings).toContain("rerank-fallback")
    expect(ok.quota.fallback).toBe(false) // 不是整体回退，只是 rerank 降级
    expect(reranks).toHaveLength(1)
  })
})

/** 内存 CacheStore：在同一测试内复用，验证「第二次命中」语义。 */
function makeMemCache(): CacheStore {
  const data = new Map<string, string>()
  return {
    async get(k) {
      return data.get(k) ?? null
    },
    async put(k, v, _ttlSeconds) {
      data.set(k, v)
    },
  }
}

describe("runSearch 纯向量结果缓存 (T1.2)", () => {
  it("相同 query+corpora+top_k 第二次命中缓存（timings.cached=true，跳过 embed/Qdrant）", async () => {
    const env = makeEnv()
    const cache = makeMemCache()

    // 第一次：未命中 → 走 embed+Qdrant，并把纯向量结果写入缓存
    const fetch1 = makeFetchMock({
      search: () =>
        Promise.resolve(
          new Response(
            searchBody([
              { id: "a", score: 0.9, payload: { title: "A", url: "u", source: "MtF Wiki", path: "p", snippet: "sa" } },
              { id: "b", score: 0.8, payload: { title: "B", url: "u", source: "MtF Wiki", path: "p", snippet: "sb" } },
            ]),
            { status: 200 },
          ),
        ),
    })
    const r1 = await runSearch({ query: "测试", corpora: ["mtf-wiki"], top_k: 2, use_reranker: false }, env, { fetchImpl: fetch1.fetchImpl, cache })
    const ok1 = asOk(r1)
    expect(ok1.timings.cached ?? false).toBe(false)
    expect(ok1.hits).toHaveLength(2)
    expect(fetch1.searches).toHaveLength(1) // 第一次有 Qdrant 调用

    // 第二次：相同 key → 命中缓存，跳过 embed/Qdrant（用会抛错/计数的 mock 证明没被调用）
    let searchCalled = false
    const fetch2 = makeFetchMock({
      search: () => {
        searchCalled = true
        return Promise.resolve(new Response(searchBody([]), { status: 200 }))
      },
    })
    const r2 = await runSearch({ query: "测试", corpora: ["mtf-wiki"], top_k: 2, use_reranker: false }, env, { fetchImpl: fetch2.fetchImpl, cache })
    const ok2 = asOk(r2)
    expect(ok2.timings.cached).toBe(true)
    expect(searchCalled).toBe(false) // Qdrant 未被调用
    expect(fetch2.searches).toHaveLength(0) // 无 /points/search 请求
    // 命中结果与第一次一致（向量初排）
    expect(ok2.hits.map((h) => h.id)).toEqual(["a", "b"])
  })

  it("top_k 不同 → key 不同 → 不命中（各跑一次向量阶段）", async () => {
    const env = makeEnv()
    const cache = makeMemCache()
    const mk = () =>
      makeFetchMock({
        search: () =>
          Promise.resolve(
            new Response(
              searchBody([
                { id: "a", score: 0.9, payload: { title: "A", url: "u", source: "MtF Wiki", path: "p", snippet: "sa" } },
                { id: "b", score: 0.8, payload: { title: "B", url: "u", source: "MtF Wiki", path: "p", snippet: "sb" } },
                { id: "c", score: 0.7, payload: { title: "C", url: "u", source: "MtF Wiki", path: "p", snippet: "sc" } },
              ]),
              { status: 200 },
            ),
          ),
      })
    const f1 = mk()
    await runSearch({ query: "测试", corpora: ["mtf-wiki"], top_k: 2, use_reranker: false }, env, { fetchImpl: f1.fetchImpl, cache })
    const f2 = mk()
    const r2 = await runSearch({ query: "测试", corpora: ["mtf-wiki"], top_k: 3, use_reranker: false }, env, { fetchImpl: f2.fetchImpl, cache })
    const ok = asOk(r2)
    expect(ok.timings.cached ?? false).toBe(false) // top_k 不同 → miss
    expect(f2.searches).toHaveLength(1)
  })

  it("命中缓存后仍可对缓存结果 rerank（cached=true 且 rerank_ms>0）", async () => {
    const env = makeEnv()
    const cache = makeMemCache()
    // 第一次：纯向量，写入缓存
    const f1 = makeFetchMock({
      search: () =>
        Promise.resolve(
          new Response(
            searchBody([
              { id: "a", score: 0.7, payload: { title: "A", url: "u", source: "MtF Wiki", path: "p", snippet: "sa" } },
              { id: "b", score: 0.9, payload: { title: "B", url: "u", source: "MtF Wiki", path: "p", snippet: "sb" } },
            ]),
            { status: 200 },
          ),
        ),
    })
    await runSearch({ query: "测试", corpora: ["mtf-wiki"], use_reranker: false, top_k: 2 }, env, { fetchImpl: f1.fetchImpl, cache })

    // 第二次：use_reranker=true，命中缓存向量阶段，但仍对缓存候选 rerank
    const f2 = makeFetchMock({
      search: () => Promise.resolve(new Response(searchBody([]), { status: 200 })),
      rerank: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { index: 0, relevance_score: 0.1 },
                { index: 1, relevance_score: 0.9 },
              ],
            }),
            { status: 200 },
          ),
        ),
    })
    const r2 = await runSearch(
      { query: "测试", corpora: ["mtf-wiki"], use_reranker: true, top_k: 2 },
      env,
      { fetchImpl: f2.fetchImpl, cache, nowMs: fakeClock(1) },
    )
    const ok = asOk(r2)
    expect(ok.timings.cached).toBe(true) // 缓存命中（向量阶段）
    expect(f2.searches).toHaveLength(0) // Qdrant 未调用
    expect(ok.timings.rerank_ms).toBeGreaterThan(0) // rerank 仍新算
  })
})

describe("runSearch 超时熔断 + 库不存在 warning (T1.3)", () => {
  it("单个库不存在(404) → 打 collection_missing warning，其余库照常返回（不再静默吞）", async () => {
    const env = makeEnv()
    // 手动构造：mtf 库正常、ftm 库 404 —— 用自定义 fetch mock 区分 collection
    const fetchImpl2 = vi.fn(async (url: unknown, _init?: RequestInit): Promise<Response> => {
      const u = String(url)
      if (u.includes("/v1/embeddings")) return new Response(JSON.stringify({ data: [{ embedding: vec() }] }), { status: 200 })
      const m = u.match(/\/collections\/([^/]+)\/points\/search$/)
      if (m) {
        if (m[1] === "mtf_wiki_v1") {
          return Promise.resolve(
            new Response(
              searchBody([
                { id: "a", score: 0.9, payload: { title: "A", url: "u", source: "MtF", path: "p", snippet: "sa" } },
              ]),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response("collection not found", { status: 404 })) // ftm_wiki_v1 不存在
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }))
    }) as unknown as typeof fetch

    const res = await runSearch({ query: "测试", corpora: ["mtf-wiki", "ftm-wiki"], top_k: 5, use_reranker: false }, env, { fetchImpl: fetchImpl2 })
    const ok = asOk(res)
    expect(ok.hits).toHaveLength(1) // mtf 正常返回
    expect(ok.hits[0].id).toBe("a")
    // 「库不存在」必须打 warning，不得静默吞掉
    expect(ok.warnings).toContain("collection-unavailable:ftm_wiki_v1:collection-missing")
    expect(ok.quota.fallback).toBe(false) // 不是整体回退
  })

  it("全部库失败（无命中）→ 整体降级回退 + warning", async () => {
    const env = makeEnv()
    const fetchImpl = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url)
      if (u.includes("/v1/embeddings")) return new Response(JSON.stringify({ data: [{ embedding: vec() }] }), { status: 200 })
      return Promise.resolve(new Response("gone", { status: 404 })) // 所有 points/search 都 404
    }) as unknown as typeof fetch

    const res = await runSearch({ query: "测试", corpora: ["mtf-wiki", "ftm-wiki"], top_k: 5, use_reranker: false }, env, { fetchImpl })
    expect(isFallback(res)).toBe(true)
    if (isFallback(res)) {
      expect(res.notice).toContain("关键词模式")
    }
    const ok = res as SearchResponse
    expect(ok.warnings).toContain("all-collections-unavailable")
  })

  it("Qdrant 检索超时（AbortError）→ qdrant-unreachable warning，不静默；其余库照常", async () => {
    const env = makeEnv()
    const fetchImpl = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url)
      if (u.includes("/v1/embeddings")) return new Response(JSON.stringify({ data: [{ embedding: vec() }] }), { status: 200 })
      const m = u.match(/\/collections\/([^/]+)\/points\/search$/)
      if (m && m[1] === "mtf_wiki_v1") {
        const err = new Error("aborted") as Error & { name: string }
        err.name = "AbortError"
        throw err // mtf 库超时
      }
      if (m && m[1] === "ftm_wiki_v1") {
        return Promise.resolve(
          new Response(
            searchBody([
              { id: "b", score: 0.8, payload: { title: "B", url: "u", source: "FtM", path: "p", snippet: "sb" } },
            ]),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }))
    }) as unknown as typeof fetch

    const res = await runSearch({ query: "测试", corpora: ["mtf-wiki", "ftm-wiki"], top_k: 5, use_reranker: false }, env, { fetchImpl })
    const ok = asOk(res) // 有库正常 → 不整体回退
    expect(ok.hits).toHaveLength(1)
    expect(ok.hits[0].id).toBe("b")
    expect(ok.warnings).toContain("collection-unavailable:mtf_wiki_v1:qdrant-unreachable")
  })

  it("parseTimeoutMs：env 覆盖 + 非法值回退默认", async () => {
    const { parseTimeoutMs } = await import("../src/search")
    expect(parseTimeoutMs(undefined)).toBe(15_000)
    expect(parseTimeoutMs("5000")).toBe(5000)
    expect(parseTimeoutMs("abc")).toBe(15_000)
    expect(parseTimeoutMs("", 2000)).toBe(2000)
  })
})
