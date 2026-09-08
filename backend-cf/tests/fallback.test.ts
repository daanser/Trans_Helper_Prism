// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — fallback 真实现单测 (tasks.md T1.3)
// 全 mock D1（模拟大行），绝不调真实上游 / Qdrant / embedding / 网络。
// 覆盖：
//   1) 断网场景：mock D1 已有 bigram 行 → runFallback("激素治疗", db) 按命中 gram 数降序返回 hits，0 fetch 调用
//   2) DB undefined → 空 hits + notice（不抛错）
//   3) splitBigrams 单测：中文 bigram、ASCII token、混合、空串
//   4) runSearch（真实 search.ts）embedding 抛错 → 整链路落 fallback（fallback:true，notice 含「关键词」）
import { describe, it, expect, vi, afterEach } from "vitest"
import { runFallback } from "../src/fallback"
import { splitBigrams, writeBigramRow } from "../src/bigram"
import { runSearch } from "../src/search"
import type { FallbackResponse } from "../src/fallback"
import type { RunSearchResult } from "../src/search"
import type { BigramRow } from "../src/bigram"
import type { Env, SearchResponse } from "../src/types"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 构造 mock D1：prepare().bind(...grams).all() 按 gram 过滤返回预置行。纯内存，零网络。 */
function makeDbMock(rows: BigramRow[]): D1Database {
  const stmt = {
    bind(...args: unknown[]) {
      return {
        all: async <T>(): Promise<{ results: T[] }> => {
          const grams = args.filter((a): a is string => typeof a === "string")
          const matched = rows.filter((r) => grams.includes(r.gram))
          return { results: matched as T[] }
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
      }
    },
  }
  return {
    prepare: () => stmt,
  } as unknown as D1Database
}

function isFallback(res: RunSearchResult): res is FallbackResponse {
  return (res as FallbackResponse).fallback === true
}

describe("runFallback 断网场景（mock D1）", () => {
  it("按 gram 命中数降序返回 hits，且 0 个 fetch/网络调用", async () => {
    // 「激素治疗」切出 [激素, 素治, 治疗]；docA 命中 2 个 gram，docB 命中 1 个。
    const rows: BigramRow[] = [
      { id: "a", wiki_id: "mtf-wiki", path: "/p/a", title: "A 激素", section: null, url: "https://a", gram: "激素", snippet: "sa" },
      { id: "a1", wiki_id: "mtf-wiki", path: "/p/a", title: "A 激素", section: null, url: "https://a", gram: "治疗", snippet: "sa" },
      { id: "b", wiki_id: "ftm-wiki", path: "/p/b", title: "B 单一", section: null, url: "https://b", gram: "激素", snippet: "sb" },
    ]
    const db = makeDbMock(rows)

    // 注入会抛错的 fetch，证明回退分支完全没用它。
    const throwFetch = vi.fn(async () => {
      throw new Error("network-should-not-hit")
    })
    vi.stubGlobal("fetch", throwFetch)

    const res = await runFallback("激素治疗", db)

    expect(res.fallback).toBe(true)
    expect(res.notice).toContain("关键词模式")
    // 按命中 gram 数降序：A（2 个）在 B（1 个）前
    expect(res.hits.map((h) => h.path)).toEqual(["/p/a", "/p/b"])
    expect(throwFetch).not.toHaveBeenCalled() // 0 个 fetch
  })

  it("单个 gram 查询也能命中（\"激素\"）", async () => {
    const rows: BigramRow[] = [
      { id: "a", wiki_id: "mtf-wiki", path: "/p/a", title: "激素", section: null, url: "u", gram: "激素", snippet: "s" },
    ]
    const db = makeDbMock(rows)
    const res = await runFallback("激素", db)
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].path).toBe("/p/a")
    expect(res.hits[0].source).toBe("mtf-wiki")
  })

  it("query 无可切内容 → 空 hits，不发 SQL，不抛错", async () => {
    const rows: BigramRow[] = []
    const db = makeDbMock(rows)
    const res = await runFallback("   ", db)
    expect(res.fallback).toBe(true)
    expect(res.hits).toEqual([])
    expect(res.notice).toContain("关键词模式")
  })
})

describe("runFallback DB undefined 优雅降级", () => {
  it("db 为 undefined → 空 hits + notice，不抛错", async () => {
    const res = await runFallback("激素", undefined)
    expect(res.fallback).toBe(true)
    expect(res.hits).toEqual([])
    expect(res.notice).toContain("关键词模式")
  })

  it("D1 查询抛错 → 降级为空 hits，不向上抛", async () => {
    const badDb = {
      prepare: () => {
        throw new Error("d1-down")
      },
    } as unknown as D1Database
    const res = await runFallback("激素", badDb)
    expect(res.fallback).toBe(true)
    expect(res.hits).toEqual([])
    expect(res.notice).toContain("关键词模式")
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

describe("writeBigramRow 写入（mock D1）", () => {
  it("返回影响行数", async () => {
    const db = makeDbMock([])
    const n = await writeBigramRow(db, {
      id: "x",
      wiki_id: "mtf-wiki",
      path: "/p",
      title: "T",
      section: null,
      url: "u",
      gram: "激素",
      snippet: "s",
      updatedAt: 123,
    })
    expect(n).toBe(1)
  })
})

describe("runSearch 触发 fallback（embedding 抛错）", () => {
  it("embedding 抛错 → 整链路落 fallback：fallback:true、notice 含「关键词」", async () => {
    // makeEnv 不提供 DB → env.DB 为 undefined，回退分支走优雅降级空 hits，仍算 fallback。
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
    // 类型断言：SearchResponse 侧也带 fallback 标记 + 原因 warning
    const full = res as unknown as SearchResponse
    expect(full.warnings).toContain("embedding-unavailable")
  })
})