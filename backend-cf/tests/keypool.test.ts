// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — Key Pool 单测 (tasks.md T0.2)
// 覆盖：
//   1) 第一个 key 401 → 自动换第二个 key 成功（withKeyRetry 换 key 重试）
//   2) 超长文本截断不抛错（embedding 的 buildInput 截断）
import { describe, it, expect, vi } from "vitest"
import { KeyPool, withKeyRetry, KeyPoolDb, PoolKey, shouldRetryStatus } from "../src/keypool"
import { SiliconFlowEmbedding } from "../src/embeddings"

/** 内存版 D1 记账 mock。 */
function makeDb(): KeyPoolDb & { usage: unknown[]; failures: unknown[] } {
  const usage: unknown[] = []
  const failures: unknown[] = []
  return {
    usage,
    failures,
    async recordUsage(rec) {
      usage.push(rec)
    },
    async markFailure(pool, keyRef, reason) {
      failures.push({ pool, keyRef, reason })
    },
  }
}

/** 构造一个带两个 key 的 embed pool。 */
function makePool() {
  const db = makeDb()
  const pool = new KeyPool(
    { EMBED_POOL_KEYS: "sk-first,sk-second", LLM_POOL_KEYS: "sk-llm-a,sk-llm-b" },
    db,
  )
  return { pool, db }
}

/** 可逐次注入响应的 fetch mock。每次调用从队列取出下一个响应；空则一直用最后一个。 */
function makeResponseQueue(): { queue: Array<{ ok: boolean; status: number }>; fetchImpl: typeof fetch } {
  const queue: Array<{ ok: boolean; status: number }> = []
  const fetchImpl = vi.fn(async (_url: any, _init?: any) => {
    const next = queue.length > 0 ? queue.shift()! : queue[queue.length - 1] ?? { ok: true, status: 200 }
    return {
      ok: next.ok,
      status: next.status,
      json: async () => ({ data: [{ embedding: new Array(1024).fill(0.1) }] }),
      text: async () => "",
    } as Response
  }) as unknown as typeof fetch
  return { queue, fetchImpl }
}

describe("KeyPool / withKeyRetry", () => {
  it("第一个 key 401 时自动换第二个 key 并成功", async () => {
    const { pool, db } = makePool()
    const { queue, fetchImpl } = makeResponseQueue()
    // 第一次尝试（key-0）：401；第二次尝试（key-1）：200
    queue.push({ ok: false, status: 401 }, { ok: true, status: 200 })

    const attempts: string[] = []
    const resp = await withKeyRetry(pool, "embed", async (key: PoolKey) => {
      attempts.push(key.secret)
      return fetchImpl("https://api.siliconflow.cn/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${key.secret}` },
      })
    })

    expect(resp.ok).toBe(true)
    expect(resp.status).toBe(200)
    // 确实用了两个不同的 key
    expect(attempts).toEqual(["sk-first", "sk-second"])
    // 第一个 key 401 后进入冷却，所以当前可用只有第二个（1 个）；冷却 5s 后会恢复
    expect(pool.availableCount("embed")).toBe(1)
    const first = pool.keys("embed").find((k) => k.ref === "embed-key-0")!
    expect(first.consecutiveFailures).toBe(1)
    expect(first.cooldownUntil).toBeGreaterThan(Date.now())
    expect(db.failures.length).toBe(1)
  })

  it("应换 key 的状态码判定正确", () => {
    expect(shouldRetryStatus(401)).toBe(true)
    expect(shouldRetryStatus(403)).toBe(true)
    expect(shouldRetryStatus(429)).toBe(true)
    expect(shouldRetryStatus(402)).toBe(true)
    expect(shouldRetryStatus(200)).toBe(false)
    expect(shouldRetryStatus(400)).toBe(false)
  })

  it("pool 无可用 key 时抛错给上层降级", async () => {
    const { pool } = makePool()
    // 把两个 key 都剔除
    await pool.reportFailure("embed", "embed-key-0", "x")
    await pool.reportFailure("embed", "embed-key-1", "x")
    await pool.reportFailure("embed", "embed-key-0", "x")
    await pool.reportFailure("embed", "embed-key-1", "x")
    await pool.reportFailure("embed", "embed-key-0", "x")
    await pool.reportFailure("embed", "embed-key-1", "x")
    await pool.reportFailure("embed", "embed-key-0", "x")
    await pool.reportFailure("embed", "embed-key-1", "x")
    await pool.reportFailure("embed", "embed-key-0", "x")
    await pool.reportFailure("embed", "embed-key-1", "x")
    expect(pool.availableCount("embed")).toBe(0)
    await expect(
      withKeyRetry(pool, "embed", async (key) => fetch("http://x", { headers: { Authorization: `B ${key.secret}` } })),
    ).rejects.toThrow(/无可用 key/)
  })

  it("连续失败达到阈值后剔除 key", async () => {
    const { pool } = makePool()
    // 连续 5 次失败 → evicted
    for (let i = 0; i < 5; i++) {
      await pool.reportFailure("embed", "embed-key-0", "upstream-429")
    }
    const k = pool.keys("embed").find((x) => x.ref === "embed-key-0")!
    expect(k.evicted).toBe(true)
    expect(pool.availableCount("embed")).toBe(1)
  })
})

describe("SiliconFlowEmbedding 超长截断", () => {
  it("超长文本截断不抛错，且发送的是截断后的文本", async () => {
    const db = makeDb()
    const pool = new KeyPool({ EMBED_POOL_KEYS: "sk-a,sk-b", LLM_POOL_KEYS: "sk-a,sk-b" }, db)
    const provider = new SiliconFlowEmbedding(
      { model: "BAAI/bge-m3", dim: 1024, endpoint: "https://api.siliconflow.cn/v1/embeddings" },
      pool,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        expect(Array.isArray(body.input)).toBe(false)
        // 输出去掉 instruction 后长度 <= 8000（截断而不抛错）
        expect(String(body.input).length).toBeLessThanOrEqual(8000)
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: new Array(1024).fill(0.5) }] }),
        } as Response
      },
    )

    const vec = await provider.embed("x".repeat(50_000), { kind: "document" })
    expect(vec).toHaveLength(1024)
  })

  it("模型维度不匹配时抛错（避免污染向量库）", async () => {
    const db = makeDb()
    const pool = new KeyPool({ EMBED_POOL_KEYS: "sk-a", LLM_POOL_KEYS: "sk-a" }, db)
    const provider = new SiliconFlowEmbedding(
      { model: "BAAI/bge-m3", dim: 1024 },
      pool,
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: new Array(768).fill(0.5) }] }),
        } as Response),
    )
    await expect(provider.embed("测试")).rejects.toThrow(/dim-mismatch/)
  })
})
