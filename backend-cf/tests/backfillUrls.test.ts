// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 存量 url 回填单测（backfillUrls.ts）
// 全 mock fetch：Qdrant scroll / set payload / GitHub raw。绝不触真实上游。
import { describe, it, expect, vi } from "vitest"
import { backfillWikiUrls } from "../src/backfillUrls"
import type { Env } from "../src/types"

function makeEnv(qdrant = "https://qdrant.example"): Env {
  return {
    QDRANT_URL: qdrant,
    QDRANT_API_KEY: "test-key",
    DB: undefined as never,
    SEARCH_CACHE: undefined as never,
    INGEST_QUEUE: undefined as never,
  } as unknown as Env
}

interface Pt {
  id: string
  payload?: Record<string, unknown>
}

/** fetch mock：scroll 返回给定点（可带 next_page_offset）；payload 写入被记录；raw 按 path 返回。 */
function makeFetch(points: Pt[], rawFiles: Record<string, string> = {}, nextOffset: string | null = null) {
  const setPayloadCalls: Array<{ payload: Record<string, unknown>; points: Array<string | number> }> = []
  const scrollBodies: Array<Record<string, unknown>> = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u.endsWith("/points/scroll")) {
      scrollBodies.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response(JSON.stringify({ result: { points, next_page_offset: nextOffset } }), { status: 200 })
    }
    if (u.endsWith("/points/payload")) {
      setPayloadCalls.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response("{}", { status: 200 })
    }
    if (u.startsWith("https://raw.githubusercontent.com/")) {
      const rel = u.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, "")
      const body = rawFiles[rel]
      if (body === undefined) return new Response("not found", { status: 404 })
      return new Response(body, { status: 200 })
    }
    return new Response("unexpected", { status: 500 })
  })
  return { fetchImpl, setPayloadCalls, scrollBodies }
}

describe("backfillWikiUrls", () => {
  it("mtf：把 GitHub blob url 改写为官网 url（同一文件多 chunk 合并为一次 set payload）", async () => {
    const points: Pt[] = [
      { id: "p1", payload: { path: "content/zh-cn/docs/medicine/zero-to-hrt.md", url: "https://github.com/project-trans/MtF-wiki/blob/master/content/zh-cn/docs/medicine/zero-to-hrt.md" } },
      { id: "p2", payload: { path: "content/zh-cn/docs/medicine/zero-to-hrt.md", url: "https://github.com/project-trans/MtF-wiki/blob/master/content/zh-cn/docs/medicine/zero-to-hrt.md" } },
    ]
    const { fetchImpl, setPayloadCalls } = makeFetch(points)
    const r = await backfillWikiUrls(makeEnv(), "mtf-wiki", { fetchImpl })

    expect(r.scanned).toBe(2)
    expect(r.updated).toBe(2)
    expect(r.skipped).toBe(0)
    expect(r.done).toBe(true)
    expect(r.next_offset).toBeNull()
    expect(setPayloadCalls.length).toBe(1) // 同 url 合并
    expect(setPayloadCalls[0].payload).toEqual({ url: "https://mtf.wiki/zh-cn/docs/medicine/zero-to-hrt" })
    expect(setPayloadCalls[0].points.sort()).toEqual(["p1", "p2"])
  })

  it("分页：带 offset 请求 scroll，并透出 next_offset（done=false）", async () => {
    const points: Pt[] = [
      { id: "p1", payload: { path: "content/zh-cn/docs/medicine/zero-to-hrt.md", url: "https://github.com/project-trans/MtF-wiki/blob/master/content/zh-cn/docs/medicine/zero-to-hrt.md" } },
    ]
    const { fetchImpl, scrollBodies } = makeFetch(points, {}, "next-page-token")
    const r = await backfillWikiUrls(makeEnv(), "mtf-wiki", { fetchImpl, offset: "prev-token", pageSize: 50 })

    expect(r.done).toBe(false)
    expect(r.next_offset).toBe("next-page-token")
    expect(scrollBodies[0].offset).toBe("prev-token")
    expect(scrollBodies[0].limit).toBe(50)
  })

  it("幂等：已是官网 url 的点跳过，不发 set payload", async () => {
    const points: Pt[] = [
      { id: "p1", payload: { path: "content/zh-cn/docs/medicine/zero-to-hrt.md", url: "https://mtf.wiki/zh-cn/docs/medicine/zero-to-hrt" } },
    ]
    const { fetchImpl, setPayloadCalls } = makeFetch(points)
    const r = await backfillWikiUrls(makeEnv(), "mtf-wiki", { fetchImpl })
    expect(r.updated).toBe(0)
    expect(r.skipped).toBe(1)
    expect(setPayloadCalls.length).toBe(0)
  })

  it("ftm：按 frontmatter slug 生成 Hugo 目录式 url", async () => {
    const points: Pt[] = [
      { id: "f1", payload: { path: "content/hrt/hrt-overview.md", url: "https://github.com/project-trans/FtM-wiki/blob/main/content/hrt/hrt-overview.md" } },
    ]
    const raw = { "content/hrt/hrt-overview.md": "---\ntitle: HRT 概论\nslug: overview\nweight: 1\n---\n正文" }
    const { fetchImpl, setPayloadCalls } = makeFetch(points, raw)
    const r = await backfillWikiUrls(makeEnv(), "ftm-wiki", { fetchImpl })
    expect(r.updated).toBe(1)
    expect(setPayloadCalls[0].payload).toEqual({ url: "https://ftm.wiki/zh-cn/hrt/overview/" })
  })

  it("ftm：raw 拉取失败时保持旧 url 并记 errors", async () => {
    const points: Pt[] = [
      { id: "f1", payload: { path: "content/hrt/missing.md", url: "https://github.com/project-trans/FtM-wiki/blob/main/content/hrt/missing.md" } },
    ]
    const { fetchImpl, setPayloadCalls } = makeFetch(points) // 无 raw 提供 → 404
    const r = await backfillWikiUrls(makeEnv(), "ftm-wiki", { fetchImpl })
    expect(r.updated).toBe(0)
    expect(r.skipped).toBe(1)
    expect(r.errors.length).toBe(1)
    expect(setPayloadCalls.length).toBe(0)
  })

  it("mio：md → .html 且走 chengxi 反代域名", async () => {
    const points: Pt[] = [
      { id: "m1", payload: { path: "docs/hrt-start.md", url: "https://github.com/KitsuMio/MioMtFWiki/blob/main/docs/hrt-start.md" } },
    ]
    const { fetchImpl, setPayloadCalls } = makeFetch(points)
    const r = await backfillWikiUrls(makeEnv(), "miomtfwiki", { fetchImpl })
    expect(r.updated).toBe(1)
    expect(setPayloadCalls[0].payload).toEqual({ url: "https://mio.chengxi.moe/MioMtFWiki/hrt-start.html" })
  })

  it("缺 Qdrant 配置 → 抛错；未知 wiki → 抛错", async () => {
    const { fetchImpl } = makeFetch([])
    const noQdrant = makeEnv()
    noQdrant.QDRANT_URL = undefined
    await expect(backfillWikiUrls(noQdrant, "mtf-wiki", { fetchImpl })).rejects.toThrow(/qdrant-unconfigured/)
    await expect(backfillWikiUrls(makeEnv(), "nope", { fetchImpl })).rejects.toThrow(/unknown-wiki/)
  })
})
