// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — wiki 注册表 单测 (tasks.md T2.1)
// 覆盖：collectionName 映射（横杠→下划线）、四库配置齐全且非空、isValidCorpus 判真/假、listWikis 稳定排序。
import { describe, it, expect } from "vitest"
import {
  DEFAULT_WIKIS,
  VALID_WIKI_IDS,
  collectionName,
  getWiki,
  isValidCorpus,
  listWikis,
  buildCorporaResponse,
} from "../src/wiki_registry"

describe("collectionName：id → Qdrant collection 映射", () => {
  it("横杠转下划线并加 _v1（与 search.ts 一致）", () => {
    expect(collectionName("mtf-wiki")).toBe("mtf_wiki_v1")
    expect(collectionName("ftm-wiki")).toBe("ftm_wiki_v1")
    expect(collectionName("rle-wiki")).toBe("rle_wiki_v1")
  })

  it("无横杠的 id 只加 _v1 后缀", () => {
    expect(collectionName("miomtfwiki")).toBe("miomtfwiki_v1")
  })

  it("多横杠也全部转换", () => {
    expect(collectionName("a-b-c")).toBe("a_b_c_v1")
  })
})

describe("四库默认配置", () => {
  it("恰好四个 wiki，且 id 都是合法白名单", () => {
    expect(DEFAULT_WIKIS).toHaveLength(4)
    for (const w of DEFAULT_WIKIS) {
      expect(VALID_WIKI_IDS).toContain(w.id)
    }
  })

  it("每个 wiki 的 repo/branch/content_dir/site_url 均非空", () => {
    for (const w of DEFAULT_WIKIS) {
      expect(w.repo).toBeTruthy()
      expect(w.branch).toBeTruthy()
      expect(w.content_dir).toBeTruthy()
      expect(w.site_url).toBeTruthy()
    }
  })

  it("repo/branch/content_dir 字段值与数据管线 one-shot-import / plan.md §7.2 对齐", () => {
    const byId = new Map(DEFAULT_WIKIS.map((w) => [w.id, w]))
    expect(byId.get("mtf-wiki")).toMatchObject({ repo: "project-trans/MtF-wiki", content_dir: "content/zh-cn" })
    expect(byId.get("ftm-wiki")).toMatchObject({ repo: "project-trans/FtM-wiki", content_dir: "content" })
    expect(byId.get("rle-wiki")).toMatchObject({ repo: "project-trans/rle-wiki", content_dir: "docs" })
    expect(byId.get("miomtfwiki")).toMatchObject({ repo: "KitsuMio/MioMtFWiki", content_dir: "docs" })
    // 分支：MtF-wiki 实测默认分支为 master（GitHub defaultBranch），其余为 main。
    const branchById: Record<string, string> = {
      "mtf-wiki": "master",
      "ftm-wiki": "main",
      "rle-wiki": "main",
      miomtfwiki: "main",
    }
    for (const w of DEFAULT_WIKIS) expect(w.branch).toBe(branchById[w.id])
  })
})

describe("getWiki / isValidCorpus", () => {
  it("getWiki 命中返回配置，未命中返回 undefined", () => {
    expect(getWiki("mtf-wiki")?.repo).toBe("project-trans/MtF-wiki")
    expect(getWiki("不存在")).toBeUndefined()
  })

  it("isValidCorpus 对白名单内判真、对白名单外判假", () => {
    for (const id of VALID_WIKI_IDS) expect(isValidCorpus(id)).toBe(true)
    expect(isValidCorpus("mtfwiki")).toBe(false)
    expect(isValidCorpus("mtf_wiki")).toBe(false)
    expect(isValidCorpus("")).toBe(false)
  })
})

describe("listWikis：稳定排序", () => {
  it("返回按 id 字典序稳定排序的列表，且不重复", () => {
    const ids = listWikis().map((w) => w.id)
    const sorted = [...ids].sort((a, b) => a.localeCompare(b))
    expect(ids).toEqual(sorted)
    expect(new Set(ids).size).toBe(ids.length)
    // 另一份调用结果一致（确定性）
    expect(listWikis().map((w) => w.id)).toEqual(ids)
  })

  it("不改动原 DEFAULT_WIKIS 内部顺序", () => {
    const before = DEFAULT_WIKIS.map((w) => w.id)
    listWikis()
    expect(DEFAULT_WIKIS.map((w) => w.id)).toEqual(before)
  })
})

describe("/api/v1/corpora 响应形状（仅数据结构）", () => {
  it("注入统计后返回每库文档数/chunk 数/更新时间", () => {
    const stats = new Map<string, { document_count: number; chunk_count: number; last_updated: string | null }>([
      ["mtf-wiki", { document_count: 120, chunk_count: 900, last_updated: "2026-09-08T00:00:00Z" }],
    ])
    const res = buildCorporaResponse(stats)
    expect(res.corpora).toHaveLength(4)
    const mtf = res.corpora.find((c) => c.id === "mtf-wiki")!
    expect(mtf).toMatchObject({ document_count: 120, chunk_count: 900, last_updated: "2026-09-08T00:00:00Z" })
    // 未注入统计的库缺省归零
    const ftm = res.corpora.find((c) => c.id === "ftm-wiki")!
    expect(ftm).toMatchObject({ document_count: 0, chunk_count: 0, last_updated: null })
  })

  it("不带统计也能构建（全归零，last_updated null）", () => {
    const res = buildCorporaResponse()
    expect(res.corpora).toHaveLength(4)
    for (const c of res.corpora) {
      expect(c.document_count).toBe(0)
      expect(c.chunk_count).toBe(0)
      expect(c.last_updated).toBeNull()
    }
  })
})