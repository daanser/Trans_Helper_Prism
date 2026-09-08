// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — index.ts 路由接线单测 (tasks.md T2.2/T2.4)
// 全 mock fetch（Qdrant collection info / scroll），验证 /api/v1/corpora、/api/v1/tree/:wiki_id 的
// 200/422/404 路径与 queue consumer 的 wikiId 分发。绝不调真实上游。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { app } from "../src/index"
import type { Env } from "../src/types"

/** 最小 Env（无 DB/queue 也不崩：路由只读 env.QDRANT_* 与 registry）。 */
function makeEnv(qdrant = true): Env {
  return {
    DB: undefined as never,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
    QDRANT_URL: qdrant ? "https://qdrant.example" : undefined,
    QDRANT_API_KEY: "qdrant-test-key",
  } as unknown as Env
}

/** fetch mock：collection info + scroll。 */
function makeFetchMock(): { fetchImpl: typeof fetch } {
  const fetchImpl = vi.fn(async (url: unknown): Promise<Response> => {
    const u = String(url)
    if (u.includes("/collections/") && u.endsWith("/points/scroll")) {
      return new Response(
        JSON.stringify({
          result: {
            points: [
              {
                payload: {
                  title: "激素治疗",
                  section_path: "治疗/激素",
                  path: "p1",
                  url: "https://u/1",
                  updated_at: "2026-01-01T00:00:00Z",
                },
              },
              {
                payload: {
                  title: "术后护理",
                  section_path: "手术/术后",
                  path: "p2",
                  url: "https://u/2",
                  updated_at: "2026-01-02T00:00:00Z",
                },
              },
            ],
            next_page_offset: null,
          },
        }),
        { status: 200 },
      )
    }
    // /collections/{name} GET → points_count
    return new Response(JSON.stringify({ result: { points_count: 42 } }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl }
}

describe("GET /api/v1/corpora", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("返回四库 corpora，chunk_count 来自 Qdrant points_count", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/corpora", {}, makeEnv())
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { corpora: Array<{ id: string; chunk_count: number; name: string }> }
    expect(body.corpora).toHaveLength(4)
    const mtf = body.corpora.find((c) => c.id === "mtf-wiki")!
    expect(mtf.chunk_count).toBe(42)
    expect(mtf.name).toBe("MtF Wiki")
  })

  it("Qdrant 未配置 → 仍返回 200，chunk_count 归零", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/corpora", {}, makeEnv(false))
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { corpora: Array<{ chunk_count: number }> }
    expect(body.corpora.every((c) => c.chunk_count === 0)).toBe(true)
    // 未配置 Qdrant 时不该发任何网络请求
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/tree/:wiki_id", () => {
  it("合法 wiki → 200 + 树（按 section_path 聚合）", async () => {
    const { fetchImpl } = makeFetchMock()
    vi.stubGlobal("fetch", fetchImpl)
    const resp = await app.request("/api/v1/tree/mtf-wiki", {}, makeEnv())
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { wiki_id: string; tree: Array<{ title: string; children: unknown[] }> }
    expect(body.wiki_id).toBe("mtf-wiki")
    expect(body.tree.length).toBeGreaterThan(0)
    expect(body.tree[0].children.length).toBeGreaterThan(0) // 治疗/激素 是 治疗 → 激素 两级的子节点
  })

  it("非法 wiki → 422", async () => {
    const resp = await app.request("/api/v1/tree/not-a-wiki", {}, makeEnv())
    expect(resp.status).toBe(422)
    expect(await resp.json()).toEqual({ error: "invalid-corpus" })
  })

  it("Qdrant 未配置 → 502", async () => {
    const resp = await app.request("/api/v1/tree/mtf-wiki", {}, makeEnv(false))
    expect(resp.status).toBe(502)
  })
})