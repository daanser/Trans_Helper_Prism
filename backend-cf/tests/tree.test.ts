// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — tree.ts 数据层单测 (tasks.md T2.4)
// 全 mock fetchImpl，绝不碰真实网络。覆盖：
//   1) fetchAllChunks scroll 分页：多页 offset 循环、payload 字段抽取、next_page_offset 为空收尾、非 2xx 抛错
//   2) buildTree 层级聚合、docCount（含子树累计）、updatedAt 取最新、乱序 chunk、空输入返回空数组
import { describe, it, expect, vi } from "vitest"
import { fetchAllChunks, buildTree, QdrantScrollError } from "../src/tree"
import type { ChunkRecord, TreeSection } from "../src/tree"

/** 便捷构造一条 chunk。 */
function chunk(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    title: "t",
    sectionPath: "",
    path: "p",
    url: "u",
    updatedAt: null,
    ...overrides,
  }
}

function scrollBody(points: Array<{ payload: Record<string, unknown> }>, next_page_offset: unknown) {
  return { result: { points, next_page_offset } }
}

/** 按调用次数依次返回预设 HTTP 响应的 fetch mock。 */
function sequentialFetch(responses: Array<() => Promise<Response>>) {
  const calls: Array<{ url: string; body: unknown }> = []
  const fn = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) })
    const responder = responses.shift()
    if (!responder) return new Response(JSON.stringify({ error: "unexpected-call" }), { status: 500 })
    return responder()
  }) as unknown as typeof fetch
  return { fetchImpl: fn, calls }
}

describe("fetchAllChunks scroll 分页", () => {
  it("多页 offset 循环：透传 offset、直到 next_page_offset 为空", async () => {
    const { fetchImpl, calls } = sequentialFetch([
      () => Promise.resolve(new Response(JSON.stringify(scrollBody([{ payload: { title: "a", section_path: "A", path: "/a", url: "u/a", updated_at: 1 } }], 10)), { status: 200 })),
      () =>
        Promise.resolve(
          new Response(JSON.stringify(scrollBody([{ payload: { title: "b", section_path: "A/B", path: "/b", url: "u/b", updated_at: 2 } }], null)), { status: 200 }),
        ),
    ])

    const chunks = await fetchAllChunks("mtf_wiki_v1", "https://qdrant.example", "k", fetchImpl)

    expect(chunks).toEqual([
      expect.objectContaining({ title: "a", sectionPath: "A", path: "/a", url: "u/a", updatedAt: 1 }),
      expect.objectContaining({ title: "b", sectionPath: "A/B", path: "/b", url: "u/b", updatedAt: 2 }),
    ])
    // 两次请求都命中 scroll 端点，第二次带 offset=10。
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("https://qdrant.example/collections/mtf_wiki_v1/points/scroll")
    expect(calls[0].body).toEqual({ limit: 500, with_payload: true })
    expect(calls[1].body).toEqual({ limit: 500, with_payload: true, offset: 10 })
  })

  it("单页就返回空（next_page_offset 为 null）时只发一次请求", async () => {
    const { fetchImpl, calls } = sequentialFetch([
      () => Promise.resolve(new Response(JSON.stringify(scrollBody([], null)), { status: 200 })),
    ])
    const chunks = await fetchAllChunks("c", "https://qdrant.example/", undefined, fetchImpl, 100)
    expect(chunks).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ limit: 100, with_payload: true })
  })

  it("字段抽取：只取 title/section_path/path/url/updated_at，其它忽略", async () => {
    const { fetchImpl } = sequentialFetch([
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              scrollBody(
                [{ payload: { title: "T", section_path: "X/Y", path: "/x/y", url: "u", updated_at: "123", snippet: "IGNORED", text: "IGNORED" } }],
                null,
              ),
            ),
            { status: 200 },
          ),
        ),
    ])
    const chunks = await fetchAllChunks("c", "https://qdrant.example", undefined, fetchImpl)
    expect(chunks[0]).toEqual({ title: "T", sectionPath: "X/Y", path: "/x/y", url: "u", updatedAt: "123" })
  })

  it("缺失字段回退默认值；非 2xx 抛 QdrantScrollError", async () => {
    const { fetchImpl } = sequentialFetch([
      () => Promise.resolve(new Response(JSON.stringify(scrollBody([{ payload: {} }], null)), { status: 200 })),
    ])
    const chunks = await fetchAllChunks("c", "https://qdrant.example", undefined, fetchImpl)
    expect(chunks[0]).toEqual({ title: "", sectionPath: "", path: "", url: "", updatedAt: null })
    // 之后再来一次失败请求：404 → 抛 QdrantScrollError，携带 status 与 collection。
    const failFetch = sequentialFetch([() => Promise.resolve(new Response("nope", { status: 404 }))])
    const err = await fetchAllChunks("missing", "https://qdrant.example", "k", failFetch.fetchImpl).catch((e) => e)
    expect(err).toBeInstanceOf(QdrantScrollError)
    expect((err as QdrantScrollError).status).toBe(404)
    expect((err as QdrantScrollError).collection).toBe("missing")
  })
})

describe("buildTree 层级聚合", () => {
  it("多级路径聚合成层级树，docCount/updatedAt 在节点与子树累计", () => {
    const tree = buildTree([
      chunk({ sectionPath: "A/B1", title: "b1", updatedAt: 100 }),
      chunk({ sectionPath: "A/B2", title: "b2", updatedAt: 300 }),
      chunk({ sectionPath: "A/B1/C", title: "c", updatedAt: 200 }),
      chunk({ sectionPath: "Top", title: "top", updatedAt: 400 }),
    ])
    expect(tree).toHaveLength(2)

    // 顶层按首个出现的章节顺序排列（此处 A 先于 Top 出现）。
    const aSec = tree[0]
    const topSec = tree[1]
    expect(topSec).toEqual({ title: "Top", children: [], docCount: 1, updatedAt: 400 })

    expect(aSec.title).toBe("A")
    expect(aSec.docCount).toBe(3)
    expect(aSec.updatedAt).toBe(300)
    expect(aSec.children).toHaveLength(2)

    const b1 = aSec.children[0]
    expect(b1).toMatchObject({ title: "B1", docCount: 2, updatedAt: 200 })
    expect(b1.children).toEqual([
      expect.objectContaining({ title: "C", docCount: 1, updatedAt: 200 }),
    ])

    const b2 = aSec.children[1]
    expect(b2).toMatchObject({ title: "B2", docCount: 1, updatedAt: 300 })
  })

  it("最新 updatedAt（乱序 chunk 取最大值）", () => {
    const tree = buildTree([
      chunk({ sectionPath: "A", updatedAt: 50 }),
      chunk({ sectionPath: "A", updatedAt: 900 }),
      chunk({ sectionPath: "A", updatedAt: 120 }),
    ])
    expect(tree[0].updatedAt).toBe(900)
    expect(tree[0].docCount).toBe(3)
  })

  it("updatedAt 支持数字与数字字符串混排，取较新者", () => {
    const tree = buildTree([
      chunk({ sectionPath: "A", updatedAt: "2000" }),
      chunk({ sectionPath: "A", updatedAt: 300 }),
    ])
    expect(tree[0].updatedAt).toBe("2000")
  })

  it("单级路径与深层路径共存", () => {
    const tree = buildTree([
      chunk({ sectionPath: "X" }),
      chunk({ sectionPath: "X/Y/Z" }),
    ])
    expect(tree[0].title).toBe("X")
    expect(tree[0].docCount).toBe(2)
    expect(tree[0].children[0].title).toBe("Y")
    expect(tree[0].children[0].children[0].title).toBe("Z")
  })

  it("乱序 chunk 结果确定：先深层后浅层也能建出正确层级", () => {
    const tree = buildTree([
      chunk({ sectionPath: "D/E/F", title: "deep" }),
      chunk({ sectionPath: "D", title: "shallow" }),
    ])
    expect(tree).toHaveLength(1)
    const d = tree[0]
    expect(d.title).toBe("D")
    expect(d.docCount).toBe(2)
    expect(d.children[0].title).toBe("E")
    expect(d.children[0].children[0].title).toBe("F")
  })

  it("空输入返回空数组", () => {
    expect(buildTree([])).toEqual([])
  })

  it("无 section_path / 空分段被跳过，不产生脏节点", () => {
    const tree = buildTree([chunk({ sectionPath: "" }), chunk({ sectionPath: "//" }), chunk({ sectionPath: "A/", updatedAt: 1 })])
    expect(tree).toHaveLength(1)
    expect(tree[0].title).toBe("A")
    expect(tree[0].docCount).toBe(1)
  })

  it("节点类型不随返回而变异：children 是可序列化的纯 TreeSection", () => {
    const tree = buildTree([chunk({ sectionPath: "A/B" })])
    const serialized = JSON.parse(JSON.stringify(tree)) as TreeSection[]
    expect(serialized[0].children[0].title).toBe("B")
  })
})