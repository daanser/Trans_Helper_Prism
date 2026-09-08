// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 官网 URL 生成器单测（wikiUrl.buildSiteUrl，ingest 期）
// 断言覆盖用户在答疑中逐条提供的四个 wiki 实测样例。
import { describe, it, expect } from "vitest"
import { buildSiteUrl, hasUrlRule } from "../src/wikiUrl"

describe("buildSiteUrl", () => {
  it("mtf: content/zh-cn/docs/X.md → mtf.wiki/zh-cn/docs/X", () => {
    expect(
      buildSiteUrl("mtf-wiki", {
        repoRootPath: "content/zh-cn/docs/medicine/zero-to-hrt.md",
        contentDirRel: "docs/medicine/zero-to-hrt.md",
        meta: { title: "零号指南" },
      }),
    ).toBe("https://mtf.wiki/zh-cn/docs/medicine/zero-to-hrt")
  })

  it("ftm: content/X.md + slug → ftm.wiki/zh-cn/<dir>/<slug>/", () => {
    expect(
      buildSiteUrl("ftm-wiki", {
        repoRootPath: "content/hrt/hrt-overview.md",
        contentDirRel: "hrt/hrt-overview.md",
        meta: { title: "HRT 概论", slug: "overview" },
      }),
    ).toBe("https://ftm.wiki/zh-cn/hrt/overview/")
  })

  it("ftm: 无 slug → 用文件名", () => {
    expect(
      buildSiteUrl("ftm-wiki", {
        repoRootPath: "content/hrt/dht.md",
        contentDirRel: "hrt/dht.md",
        meta: {},
      }),
    ).toBe("https://ftm.wiki/zh-cn/hrt/dht/")
  })

  it("ftm: _index.md → 目录本身", () => {
    expect(
      buildSiteUrl("ftm-wiki", {
        repoRootPath: "content/hrt/_index.md",
        contentDirRel: "hrt/_index.md",
        meta: {},
      }),
    ).toBe("https://ftm.wiki/zh-cn/hrt/")
  })

  it("rle: docs/X.md → rle.wiki/X", () => {
    expect(
      buildSiteUrl("rle-wiki", {
        repoRootPath: "docs/campus/UESTC.md",
        contentDirRel: "campus/UESTC.md",
        meta: { title: "电子科技大学" },
      }),
    ).toBe("https://rle.wiki/campus/UESTC")
  })

  it("mio: docs/X.md → mio.chengxi.moe/MioMtFWiki/X.html", () => {
    expect(
      buildSiteUrl("miomtfwiki", {
        repoRootPath: "docs/hrt-lifespan-myth.md",
        contentDirRel: "hrt-lifespan-myth.md",
        meta: {},
      }),
    ).toBe("https://mio.chengxi.moe/MioMtFWiki/hrt-lifespan-myth.html")
  })

  it("mio: index → 目录 index.html", () => {
    expect(
      buildSiteUrl("miomtfwiki", {
        repoRootPath: "docs/index.md",
        contentDirRel: "index.md",
        meta: {},
      }),
    ).toBe("https://mio.chengxi.moe/MioMtFWiki/index.html")
  })

  it("未注册 wiki：回退 blob 形式且不抛错", () => {
    const out = buildSiteUrl("unknown-wiki", {
      repoRootPath: "content/a.md",
      contentDirRel: "a.md",
    })
    expect(out).toContain("unknown-repo")
  })
})

describe("hasUrlRule", () => {
  it("四个注册 wiki 有规则，未知没有", () => {
    for (const id of ["mtf-wiki", "ftm-wiki", "rle-wiki", "miomtfwiki"]) {
      expect(hasUrlRule(id)).toBe(true)
    }
    expect(hasUrlRule("other")).toBe(false)
  })
})