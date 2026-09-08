// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — rerank.ts 单测 (tasks.md T1.1)
// 全 mock global fetch，绝不调真实上游。覆盖：
//   1) (query, docs) 批量返回按 docs 顺序一致的分数数组
//   2) 多 batch：docs 超过 batchSize 时按批多次上游调用（禁逐条循环）
//   3) 按上游返回的 index 还原顺序（乱序 index 也能对齐）
//   4) 上游返回条数与 docs 不符 → 抛错（rerank-count-mismatch）
//   5) 空 docs → 立即返回 []（零上游调用）
import { describe, it, expect, vi } from "vitest"
import { SiliconFlowReranker, RerankProvider } from "../src/rerank"
import { KeyPool } from "../src/keypool"
import type { KeyPoolDb } from "../src/keypool"

/** 最小 KeyPoolDb（记账空实现）。 */
const noopDb: KeyPoolDb = { async recordUsage() {} }

/** 构造一个带 llm_pool 单 key 的 pool。 */
function makePool(): KeyPool {
  return new KeyPool({ LLM_POOL_KEYS: "sk-rerank-a" }, noopDb)
}

/** 空容器：keys 记录 simulation 里创建过的 provider 调用列表。 */
type RerankCall = { query: string; documents: string[]; model?: string }

/** 按 URL 路由的 fetch mock：/v1/rerank 返回按原顺序的 relevance_score。 */
function makeFetchMock(opts: {
  result?: (body: { query: string; documents: string[]; model?: string }) => Array<{ index: number; relevance_score: number }>
}): { fetchImpl: typeof fetch; calls: RerankCall[] } {
  const calls: RerankCall[] = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (!u.includes("/v1/rerank")) return new Response("unexpected-url", { status: 500 })
    const body = JSON.parse(String(init?.body ?? "{}")) as RerankCall
    calls.push(body)
    const results = opts.result
      ? opts.result(body)
      : body.documents.map((_, i) => ({ index: i, relevance_score: 1 - i * 0.1 }))
    return new Response(JSON.stringify({ model: body.model, results }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe("SiliconFlowReranker.rerank", () => {
  it("按 docs 顺序返回分数数组（单 batch）", async () => {
    const pool = makePool()
    const { fetchImpl, calls } = makeFetchMock({})
    const r: RerankProvider = new SiliconFlowReranker({ model: "BAAI/bge-reranker-v2-m3" }, pool, fetchImpl)
    const scores = await r.rerank("测试", ["d0", "d1", "d2"])
    expect(scores).toHaveLength(3)
    expect(scores[0]).toBeCloseTo(1) // i=0 → 1 - 0*0.1
    expect(scores[1]).toBeCloseTo(0.9)
    expect(scores[2]).toBeCloseTo(0.8)
    expect(calls).toHaveLength(1) // 一个 batch 一次上游调用
    expect(calls[0].query).toBe("测试")
    expect(calls[0].documents).toEqual(["d0", "d1", "d2"])
  })

  it("多 batch：docs 超过 batchSize 时按批多次调用（非逐条循环）", async () => {
    const pool = makePool()
    const { fetchImpl, calls } = makeFetchMock({})
    const r: RerankProvider = new SiliconFlowReranker({ model: "m" }, pool, fetchImpl)
    const docs = Array.from({ length: 5 }, (_, i) => `d${i}`)
    const scores = await r.rerank("q", docs, { batchSize: 2 })
    // 5 条 / batch 2 → 3 批上游调用（不是 5 次）
    expect(calls).toHaveLength(3)
    expect(calls[0].documents).toEqual(["d0", "d1"])
    expect(calls[1].documents).toEqual(["d2", "d3"])
    expect(calls[2].documents).toEqual(["d4"])
    // 分数长度与 docs 一一对应
    expect(scores).toHaveLength(5)
    // 每批内按局部 index 重新打分（mock 公式 1 - local_i*0.1）→ 每批首条最高
    expect(scores[0]).toBeCloseTo(1) // d0（batch0 index0）
    expect(scores[1]).toBeCloseTo(0.9)
    expect(scores[2]).toBeCloseTo(1) // d2（batch1 index0）
    expect(scores[3]).toBeCloseTo(0.9)
    expect(scores[4]).toBeCloseTo(1) // d4（batch2 index0）
  })

  it("乱序 index 也能按 index 还原到对应 docs 位", async () => {
    const pool = makePool()
    const { fetchImpl } = makeFetchMock({
      result: () => [
        { index: 1, relevance_score: 0.99 }, // d1 最高
        { index: 0, relevance_score: 0.5 },
        { index: 2, relevance_score: 0.1 },
      ],
    })
    const r: RerankProvider = new SiliconFlowReranker({ model: "m" }, pool, fetchImpl)
    const scores = await r.rerank("q", ["d0", "d1", "d2"])
    expect(scores).toEqual([0.5, 0.99, 0.1]) // 顺序不变，分数按 index 对齐
  })

  it("上游返回条数与 docs 不符 → 抛 rerank-count-mismatch", async () => {
    const pool = makePool()
    const broken = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 }),
    ) as unknown as typeof fetch
    const r: RerankProvider = new SiliconFlowReranker({ model: "m" }, pool, broken)
    await expect(r.rerank("q", ["d0", "d1"])).rejects.toThrow(/rerank-count-mismatch/)
  })

  it("空 docs → 立即返回 []，零上游调用", async () => {
    const pool = makePool()
    const { fetchImpl, calls } = makeFetchMock({})
    const r: RerankProvider = new SiliconFlowReranker({ model: "m" }, pool, fetchImpl)
    const scores = await r.rerank("q", [])
    expect(scores).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe("rerank 换 key 重试（withKeyRetry）", () => {
  it("第一个 key 401 → 自动换第二个 key 成功；换 key 后取到正确分数", async () => {
    let callNo = 0
    const pool2 = new KeyPool({ LLM_POOL_KEYS: "sk-a,sk-b" }, noopDb)
    // 第一个 key 首次调用返回 401，第二次（换 key 后）成功
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      callNo++
      if (callNo === 1) return new Response("unauthorized", { status: 401 })
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.88 }] }), { status: 200 })
    }) as unknown as typeof fetch
    const r: RerankProvider = new SiliconFlowReranker({ model: "m" }, pool2, fetchImpl)
    const scores = await r.rerank("q", ["d"])
    expect(scores).toEqual([0.88])
    expect(callNo).toBe(2)
  })
})