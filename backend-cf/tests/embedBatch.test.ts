// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — embedBatch/estimateTokens 单测 (tasks.md T0.3 / §5.3)
// mock fetch（绝不调真实上游）。覆盖：
//   1) embedBatch 一次 HTTP 发多条（input 为数组）
//   2) 超过 batchSize 自动拆成多批
//   3) 429 退避重试 + 自动换 key（第一个 key 429 → 第二个 key 成功）
//   4) estimateTokens 粗估
import { describe, it, expect, vi } from "vitest"
import { SiliconFlowEmbedding, estimateTokens, chunkBatches } from "../src/embeddings"
import { KeyPool } from "../src/keypool"

/** 内存版 KeyPool db mock。 */
function makeDb() {
  return {
    async recordUsage() {},
    async markFailure() {},
  }
}

/** 用两个 key 构造一个 embed provider + 可注入响应的 fetch mock。 */
function makeProvider(fetchImpl: typeof fetch) {
  const db = makeDb()
  const pool = new KeyPool({ EMBED_POOL_KEYS: "sk-first,sk-second", LLM_POOL_KEYS: "sk-llm", RERANK_POOL_KEYS: "" }, db)
  const provider = new SiliconFlowEmbedding(
    { model: "BAAI/bge-m3", dim: 1024, endpoint: "https://api.siliconflow.cn/v1/embeddings" },
    pool,
    fetchImpl,
  )
  return { provider, pool }
}

/** 记录每次调用的 fetch 实现。按队列依次出响应，空则用最后一个。 */
function makeFetchMock() {
  const queue: Array<{ ok: boolean; status: number }> = []
  const calls: Array<{ url: string; body: any; auth: string }> = []
  const fetchImpl = vi.fn(async (url: unknown, init?: any) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      auth: String(init?.headers?.Authorization ?? ""),
    })
    const next = queue.length > 0 ? queue.shift()! : queue[queue.length - 1] ?? { ok: true, status: 200 }
    return {
      ok: next.ok,
      status: next.status,
      json: async () => ({
        data: Array.from({ length: (JSON.parse(String(init?.body ?? "{}")).input as string[]).length }, () => ({ embedding: new Array(1024).fill(0.5) })),
      }),
      text: async () => "rate limited",
    } as Response
  }) as unknown as typeof fetch
  return { fetchImpl, queue, calls }
}

/** 一个不等待的 sleep（让测试尽可能快）。 */
const noSleep = async () => {}

describe("embedBatch", () => {
  it("一次 HTTP 发送多条（input 为数组），返回与入参顺序一致的向量", async () => {
    const { fetchImpl, calls } = makeFetchMock()
    const { provider } = makeProvider(fetchImpl)
    const texts = ["第一条", "第二条", "第三条"]
    const vecs = await provider.embedBatch(texts, { kind: "document", batch: { sleep: noSleep } })

    expect(vecs).toHaveLength(3)
    expect(vecs[0]).toHaveLength(1024)
    // 只发了一次请求，且 input 是数组（不是单条字符串）
    expect(calls.length).toBe(1)
    const body = calls[0].body
    expect(Array.isArray(body.input)).toBe(true)
    expect(body.input).toEqual(["第一条", "第二条", "第三条"])
  })

  it("超过 batchSize 自动拆成多批", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: any) => ({
      ok: true,
      status: 200,
      json: async () => {
        const input = (JSON.parse(String(init?.body ?? "{}")).input as string[]) ?? []
        return { data: input.map(() => ({ embedding: new Array(1024).fill(0.1) })) }
      },
      text: async () => "",
    })) as unknown as typeof fetch
    const { provider } = makeProvider(fetchImpl)
    const texts = ["a", "b", "c", "d", "e"] // 5 条
    const vecs = await provider.embedBatch(texts, { batch: { batchSize: 2, sleep: noSleep } })
    expect(vecs).toHaveLength(5)
    // 5 条 / 2 = 3 批
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("429 退避重试并自动换 key（第一个 key 429 → 第二个 key 成功）", async () => {
    const specialFetch = vi.fn(async (_url: unknown, init?: any) => {
      const auth = String((init?.headers as any)?.Authorization ?? "")
      // 第一个 key 触发一次 429，第二个 key 200
      if (auth.includes("sk-first") && !specialFetch.firstTried) {
        specialFetch.firstTried = true
        return { ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" } as Response
      }
      const input = (JSON.parse(String(init?.body ?? "{}")).input as string[]) ?? []
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: input.map(() => ({ embedding: new Array(1024).fill(0.5) })) }),
        text: async () => "",
      } as Response
    }) as unknown as typeof fetch & { firstTried?: boolean }
    specialFetch.firstTried = false

    const { provider, pool } = makeProvider(specialFetch)
    const vecs = await provider.embedBatch(["x", "y"], { batch: { maxRetries: 3, sleep: noSleep } })
    expect(vecs).toHaveLength(2)
    // 触发过 429 后，第一个 key 进入冷却
    const first = pool.keys("embed").find((k) => k.ref === "embed-key-0")!
    expect(first.consecutiveFailures).toBeGreaterThanOrEqual(1)
    // 重试发生了（specialFetch 被调用 >=2 次：一次 429 + 一次 200）
    expect(specialFetch).toHaveBeenCalledTimes(2)
  })
})

describe("estimateTokens", () => {
  it("按 ~1.8 token/汉字 粗估中文", () => {
    const t = estimateTokens(["你好世界"]) // 4 个汉字
    expect(t).toBe(Math.round(4 * 1.8))
  })

  it("英文按词粗估", () => {
    const t = estimateTokens(["hello world"]) // 2 个词
    expect(t).toBe(Math.round(2 * 1.3))
  })

  it("空输入为 0", () => {
    expect(estimateTokens([])).toBe(0)
  })
})

describe("chunkBatches", () => {
  it("按 batchSize 切分", () => {
    expect(chunkBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkBatches([], 2)).toEqual([])
  })
})
