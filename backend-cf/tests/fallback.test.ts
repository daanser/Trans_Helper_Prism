// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — fallback 真实现单测 (tasks.md T1.3)
// 全 mock fetch（Qdrant scroll 全文检索），绝不调真实上游 / embedding / 网络。
// 覆盖：
//   1) 正常：Qdrant 全文命中 → 按本地 token 命中度降序返回 hits，并带上正确 filter
//   2) 同 path 多 chunk 去重，取最高分
//   3) 单库失败不影响其它库
//   4) Qdrant 未配置 / 空 query → 空 hits + notice（不抛错）
//   5) splitBigrams 切分
//   6) runSearch（真实 search.ts）embedding 抛错 → 整链路落 fallback
import { describe, it, expect, vi, afterEach } from "vitest"
import { runFallback } from "../src/fallback"
import { splitBigrams } from "../src/bigram"
import { runSearch } from "../src/search"
import type { FallbackResponse } from "../src/fallback"
import type { RunSearchResult } from "../src/search"
import type { Env, SearchResponse } from "../src/types"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface MockPoint {
  id: string
  payload: Record<string, unknown>
}

/** mock Qdrant scroll：按 collection 返回预置点；failColls 里的库返回 500。 */
function makeQdrantFetch(byColl: Record<string, MockPoint[]>, failColls: string[] = []) {
  const calls: Array<{ coll: string; body: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    const m = /\/collections\/([^/]+)\/points\/scroll/.exec(u)
    if (m) {
      const coll = m[1]
      calls.push({ coll, body: JSON.parse(String(init?.body ?? "{}")) })
      if (failColls.includes(coll)) return new Response("boom", { status: 500 })
      return new Response(JSON.stringify({ result: { points: byColl[coll] ?? [] } }), { status: 200 })
    }
    return new Response("unexpected", { status: 500 })
  })
  return { fetchImpl, calls }
}

function isFallback(res: RunSearchResult): res is FallbackResponse {
  return (res as FallbackResponse).fallback === true
}

const ENV = { QDRANT_URL: "https://q.example", QDRANT_API_KEY: "k" }

describe("runFallback（Qdrant 全文索引）", () => {
  it("按 token 命中度降序返回 hits，并带上 text match filter", async () => {
    const byColl = {
      mtf_wiki_v1: [
        { id: "p1", payload: { path: "a.md", title: "A", text: "激素 治疗 激素", url: "https://mtf.wiki/a", wiki_id: "mtf-wiki" } },
        { id: "p2", payload: { path: "b.md", title: "B", text: "仅治疗", url: "https://mtf.wiki/b", wiki_id: "mtf-wiki" } },
      ],
    }
    const { fetchImpl, calls } = makeQdrantFetch(byColl)
    const res = await runFallback("激素治疗", ["mtf-wiki"], ENV, { fetchImpl })

    expect(res.fallback).toBe(true)
    expect(res.hits.map((h) => h.path)).toEqual(["a.md", "b.md"])
    expect(res.hits[0].url).toBe("https://mtf.wiki/a")
    expect(calls.length).toBe(1)
    expect(calls[0].coll).toBe("mtf_wiki_v1")
    expect(calls[0].body.filter).toEqual({ must: [{ key: "text", match: { text: "激素治疗" } }] })
    expect(res.notice).toContain("关键词模式")
  })

  it("同 path 多 chunk → 去重取最高分", async () => {
    const byColl = {
      mtf_wiki_v1: [
        { id: "p1", payload: { path: "a.md", text: "治疗", wiki_id: "mtf-wiki", url: "u1", title: "A" } },
        { id: "p2", payload: { path: "a.md", text: "激素 治疗 激素", wiki_id: "mtf-wiki", url: "u1", title: "A" } },
      ],
    }
    const { fetchImpl } = makeQdrantFetch(byColl)
    const res = await runFallback("激素治疗", ["mtf-wiki"], ENV, { fetchImpl })
    expect(res.hits.length).toBe(1)
    expect(res.hits[0].score).toBeGreaterThan(1)
  })

  it("单库失败不影响其它库", async () => {
    const byColl = {
      mtf_wiki_v1: [{ id: "p1", payload: { path: "a.md", text: "激素", wiki_id: "mtf-wiki", url: "u", title: "A" } }],
    }
    const { fetchImpl } = makeQdrantFetch(byColl, ["rle_wiki_v1"])
    const res = await runFallback("激素", ["rle-wiki", "mtf-wiki"], ENV, { fetchImpl })
    expect(res.hits.length).toBe(1)
    expect(res.hits[0].source).toBe("mtf-wiki")
  })

  it("Qdrant 未配置 → 空 hits + notice，不抛错", async () => {
    const res = await runFallback("激素", ["mtf-wiki"], {})
    expect(res.fallback).toBe(true)
    expect(res.hits).toEqual([])
    expect(res.notice).toContain("关键词模式")
  })

  it("空 query / 纯标点 → 空 hits，不发请求", async () => {
    const { fetchImpl, calls } = makeQdrantFetch({})
    const res = await runFallback("   ", ["mtf-wiki"], ENV, { fetchImpl })
    expect(res.hits).toEqual([])
    expect(calls.length).toBe(0)
  })
})

describe("splitBigrams 切分", () => {
  it("中文：连续 CJK 成对切 bigram", () => {
    expect(splitBigrams("激素治疗")).toEqual(["激素", "素治", "治疗"])
  })

  it("ASCII：连续字母/数字输出整词 token（小写）", () => {
    expect(splitBigrams("Hormone HTML5")).toEqual(["hormone", "html5"])
  })

  it("混合：中英混排各自切分", () => {
    expect(splitBigrams("激素 hormone 治疗")).toEqual(["激素", "hormone", "治疗"])
  })

  it("空串 / 纯标点 → []", () => {
    expect(splitBigrams("")).toEqual([])
    expect(splitBigrams("   ,，！？ ")).toEqual([])
  })

  it("单 CJK 字降级为该字本身", () => {
    expect(splitBigrams("激")).toEqual(["激"])
  })
})

describe("bigram 模块只做分词（不再有任何 D1 写入口）", () => {
  it("模块只导出 splitBigrams（writeBigramRow / BigramRow 等已随 bigram_index 表一起删除）", async () => {
    const mod = (await import("../src/bigram")) as Record<string, unknown>
    expect(Object.keys(mod).sort()).toEqual(["splitBigrams"])
    expect(mod.writeBigramRow).toBeUndefined()
  })

  it("splitBigrams 是纯函数：同样输入两次调用结果一致（无状态、无 IO）", () => {
    const a = splitBigrams("激素治疗 hormone")
    const b = splitBigrams("激素治疗 hormone")
    expect(a).toEqual(b)
    expect(a).toEqual(["激素", "素治", "治疗", "hormone"])
  })
})

describe("runSearch 触发 fallback（embedding 抛错）", () => {
  it("embedding 抛错 → 整链路落 fallback：fallback:true、notice 含「关键词」", async () => {
    const env = {
      EMBED_POOL_KEYS: "sk-embed-a",
      LLM_POOL_KEYS: "sk-llm-a",
    } as Partial<Env> as Env
    const fetchImpl = vi.fn(async () => {
      throw new Error("embedding-upstream-down")
    }) as unknown as typeof fetch

    const res = await runSearch({ query: "激素", corpora: ["mtf-wiki"] }, env, { fetchImpl })

    expect(isFallback(res)).toBe(true)
    if (!isFallback(res)) return
    expect(res.hits).toEqual([])
    expect(res.notice).toContain("关键词")
    const full = res as unknown as SearchResponse
    expect(full.warnings).toContain("embedding-unavailable")
  })
})
