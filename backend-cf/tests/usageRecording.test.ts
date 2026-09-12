// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 检索链路用量记账单测
// 目的：确认 embeddings / rerank 也走 `KeyPool.recordUsage`，否则 /admin/usage 的
// 「每账号请求数」对"只搜索、不开 LLM"的账号永远是 0（线上曾如此）。
// 全 mock fetch，零网络。
import { describe, it, expect, vi } from "vitest"
import { createEmbeddingProvider } from "../src/embeddings"
import { createRerankProvider } from "../src/rerank"
import type { KeyPoolDb, UsageRecord } from "../src/keypool"
import { poolKeysEnv } from "./poolKeysEnv"

function makeDb() {
  const records: UsageRecord[] = []
  const db: KeyPoolDb = {
    async recordUsage(rec) {
      records.push(rec)
    },
  }
  return { db, records }
}

const ENV = poolKeysEnv(["sk-test-embed-a", "sk-test-llm-a"])

describe("检索链路记账（embeddings / rerank）", () => {
  it("embedding 成功后写 key_usage：pool=embed、endpoint=embeddings、status=ok", async () => {
    const { db, records } = makeDb()
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.1) }] }), { status: 200 })
    }) as unknown as typeof fetch
    const { provider } = createEmbeddingProvider(ENV, db, fetchImpl)

    await provider.embed("激素治疗", { kind: "query" })
    // recordUsage 是 fire-and-forget，等一个微任务
    await new Promise((r) => setTimeout(r, 0))

    expect(records.length).toBe(1)
    expect(records[0].pool).toBe("embed")
    expect(records[0].endpoint).toBe("embeddings")
    expect(records[0].status).toBe("ok")
    expect(records[0].keyRef).toMatch(/^pool-key-\d+$/)
    expect(typeof records[0].tokensIn).toBe("number")
  })

  it("embedding 失败也记账（status=failed）", async () => {
    const { db, records } = makeDb()
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response("bad request", { status: 400 })) as unknown as typeof fetch
    const { provider } = createEmbeddingProvider(ENV, db, fetchImpl)

    await expect(provider.embed("x")).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 0))

    expect(records.length).toBeGreaterThanOrEqual(1)
    expect(records[0].status).toBe("failed")
    expect(records[0].statusCode).toBe(400)
    expect(records[0].endpoint).toBe("embeddings")
  })

  it("rerank 成功后写 key_usage：pool=rerank、endpoint=rerank、status=ok", async () => {
    const { db, records } = makeDb()
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 })
    }) as unknown as typeof fetch
    const { provider } = createRerankProvider(ENV, db, fetchImpl)

    await provider.rerank("q", ["doc"])
    await new Promise((r) => setTimeout(r, 0))

    expect(records.length).toBe(1)
    expect(records[0].pool).toBe("rerank")
    expect(records[0].endpoint).toBe("rerank")
    expect(records[0].status).toBe("ok")
  })

  it("记账 db 抛错不影响检索结果（fail-open）", async () => {
    const db: KeyPoolDb = {
      async recordUsage() {
        throw new Error("d1-down")
      },
    }
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.2) }] }), { status: 200 })
    }) as unknown as typeof fetch
    const { provider } = createEmbeddingProvider(ENV, db, fetchImpl)

    const vec = await provider.embed("x", { kind: "query" })
    expect(vec.length).toBe(1024)
  })
})
