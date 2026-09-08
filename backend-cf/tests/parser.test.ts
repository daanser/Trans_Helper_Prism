// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — parser/分块 单测 (tasks.md T0.3 / T2.3)
// 覆盖：frontmatter（含 list）、shortcode、HTML 注释、多余空行、_index.md 目录元映射、
//       标题分级分块 + overlap、chunk 记录全字段断言、point id 确定性。
// 全部纯字符串操作（无网络、无 IO）。
// T2.3 新增：3 篇「脏」markdown fixture（tests/fixtures/）+ 边界 case。
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 从 tests/fixtures/ 读取 fixture 正文。 */
function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf8")
}
import {
  parseFrontmatter,
  cleanBody,
  buildDirMeta,
  folderTitle,
  resolvePathMeta,
  chunkMarkdown,
  chunkMarkdownWithText,
  pointId,
} from "../src/ingest/parser"

describe("parseFrontmatter", () => {
  it("解析基础 key:value + 简单列表（含引号元素）", () => {
    const { meta, body } = parseFrontmatter(
      `---
title: 测试文档
tags: [a, b, "c d"]
authors: ["Alice", 'Bob']
---
这是正文。`,
    )
    expect(meta.title).toBe("测试文档")
    expect(meta.tags).toEqual(["a", "b", "c d"])
    expect(meta.authors).toEqual(["Alice", "Bob"])
    expect(body).toBe("这是正文。")
  })

  it("无 frontmatter 时 meta 为空、body 为全文", () => {
    const { meta, body } = parseFrontmatter("普通内容，无分隔符。")
    expect(meta).toEqual({})
    expect(body).toBe("普通内容，无分隔符。")
  })

  it("单行值去掉引号", () => {
    const { meta } = parseFrontmatter('---\nauthor: "张三"\n---\n')
    expect(meta.author).toBe("张三")
  })
})

describe("cleanBody", () => {
  it("去掉 Hugo shortcode 与 HTML 注释，合并多余空行", () => {
    const dirty = `<!-- 这是注释 -->
{{< video src="x" >}}
{{% notice info %}}提示{{% /notice %}}
第一行


第二行

第三行`
    const out = cleanBody(dirty)
    expect(out).not.toContain("<!--")
    expect(out).not.toContain("{{<")
    expect(out).not.toContain("{{%")
    expect(out).not.toContain("这是注释")
    expect(out).not.toMatch(/\n{3,}/)
    expect(out).toContain("第一行")
    expect(out).toContain("第二行")
  })

  it("跨行 shortcode 也能去掉", () => {
    const dirty = `开头
{{< tab
  name="a"
>}}中间{{< /tab >}}
结尾`
    const out = cleanBody(dirty)
    expect(out).not.toContain("{{<")
    expect(out).toContain("开头")
    expect(out).toContain("结尾")
  })
})

describe("_index.md 目录元映射", () => {
  const files = [
    { path: "_index.md", content: "---\ntitle: 根标题\n---\n" },
    { path: "guide/_index.md", content: "---\ntitle: 指南\n---\n" },
    { path: "guide/health/_index.md", content: "---\ntitle: 健康\n---\n" },
    { path: "guide/health/hrt.md", content: "---\ntitle: 激素\n---\n正文内容激素治疗。" },
    { path: "guide/surgery.md", content: "---\ntitle: 手术\n---\n正文。" },
    { path: "about.md", content: "---\ntitle: 关于\n---\n正文。" },
  ]

  const dirMeta = buildDirMeta(files)

  it("建立 目录路径 -> meta 映射（根为空串）", () => {
    expect(Object.keys(dirMeta).sort()).toEqual(["", "guide", "guide/health"])
    expect(folderTitle("guide", "guide", dirMeta)).toBe("指南")
    expect(folderTitle("guide/health", "health", dirMeta)).toBe("健康")
    expect(folderTitle("notexist", "fallback", dirMeta)).toBe("fallback")
  })

  it("resolvePathMeta：嵌套目录拼 chapter 链", () => {
    const m = resolvePathMeta("guide/health/hrt.md", dirMeta, null)
    expect(m.category).toBe("指南")
    expect(m.chapter).toBe("健康")
  })

  it("resolvePathMeta：单层目录只有 category，无 chapter", () => {
    const m = resolvePathMeta("guide/surgery.md", dirMeta, null)
    expect(m.category).toBe("指南")
    expect(m.chapter).toBeNull()
  })

  it("resolvePathMeta：根级文件 category/chapter 均空", () => {
    const m = resolvePathMeta("about.md", dirMeta, null)
    expect(m.category).toBeNull()
    expect(m.chapter).toBeNull()
  })

  it("resolvePathMeta 可被 defaultCat 覆盖", () => {
    const m = resolvePathMeta("about.md", dirMeta, "顶层")
    expect(m.category).toBe("顶层")
  })
})

describe("chunkMarkdown：标题分级 + overlap + 全字段", () => {
  const base = {
    wiki_id: "mtf-wiki",
    path: "guide/health/hrt.md",
    title: "激素治疗",
    section: { category: "指南", chapter: "健康" },
    url: "https://wiki.transhelper.org/mtf/guide/health/hrt.md",
    commit_sha: "abc123def",
    updated_at: "2026-09-07T00:00:00.000Z",
  }

  it("按标题分级产生多个 chunk，section 含标题链，chunk_index 递增", () => {
    const body = new Array(20).fill("这是一段正文内容。").join("")
    const recs = chunkMarkdown({ ...base, body }, { maxChars: 1200, overlap: 150, minLen: 0 })
    // 长正文 + 标题会各成或并入窗口；断言至少 1 条且字段齐全
    expect(recs.length).toBeGreaterThan(0)
    for (const r of recs) {
      expect(Object.keys(r).sort()).toEqual(
        ["chunk_index", "commit_sha", "path", "section", "title", "updated_at", "url", "wiki_id"].sort(),
      )
      expect(r.wiki_id).toBe("mtf-wiki")
      expect(r.path).toBe("guide/health/hrt.md")
      expect(r.url).toBe("https://wiki.transhelper.org/mtf/guide/health/hrt.md")
      expect(r.commit_sha).toBe("abc123def")
      expect(r.updated_at).toBe("2026-09-07T00:00:00.000Z")
    }
    expect(recs.map((r) => r.chunk_index)).toEqual(recs.map((_, i) => i))
  })

  it("同一 section 内容超过 maxChars 时切出多个窗口且 overlap", () => {
    // 一段长内容（用 ASCII 以便精确断言 overlap 边界），无标题则整段为 preamble。
    const longBody = "# 一节\n" + "A".repeat(100)
    const items = chunkMarkdownWithText(
      { ...base, body: longBody },
      { maxChars: 50, overlap: 10, minLen: 0, includeHeading: true },
    )
    const texts = items.map((x) => x.text)
    const recs = items.map((x) => x.record)
    // 内容 100 字符 + 标题前缀，窗口化后应多片
    expect(texts.length).toBeGreaterThan(1)
    // 相邻窗口必重叠 overlap 字符：后一窗口开头 overlap 字符 == 前一窗口末尾 overlap 字符
    expect(texts[1].slice(0, 10)).toBe(texts[0].slice(-10))
    // 拼接所有窗口能覆盖全部内容（无遗漏）
    expect(texts.map((t) => t.length).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(100)
    // 所有 record 字段齐全
    for (const { record } of items) {
      expect(record.chunk_index).toBeGreaterThanOrEqual(0)
      expect(record.title).toBeTruthy()
    }
    expect(recs.map((r) => r.chunk_index)).toEqual(recs.map((_, i) => i))
  })

  it("重度分节文档不被切成每标题碎片（贪心合并，平均接近 maxChars）", () => {
    // 模拟 MtF 那样大量 h2/h3 短章节：每个标题后仅几行正文。
    // 贪心合并应把相邻短章节并入一个 chunk，避免产出几十个 ~100 字符碎片。
    let body = "# 总述\n"
    for (let i = 0; i < 80; i++) {
      body += `\n## 小节${i}\n\n这是第 ${i} 小节的正文内容，用于填充。\n`
    }
    const items = chunkMarkdownWithText(
      { ...base, body },
      { maxChars: 1200, overlap: 150, minLen: 0, includeHeading: true },
    )
    const lens = items.map((x) => x.text.length)
    // 80 个 h2 章节 + 1 个 h1：若按标题各切一块会有 ~81 块；贪心合并后应远小于标题数且 >1
    expect(items.length).toBeGreaterThan(1)
    expect(items.length).toBeLessThan(15)
    // 平均长度应明显大于碎片的 ~100 字符（接近 maxChars 量级）
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length
    expect(avg).toBeGreaterThan(400)
  })

  it("正文过短（低于 minLen）返回空数组", () => {
    const recs = chunkMarkdown({ ...base, body: "短" }, { maxChars: 1200, overlap: 150, minLen: 50 })
    expect(recs).toEqual([])
  })

  it("section 字段把 _index.md 解析出的 category/chapter 拼进标题链", () => {
    const body = "# 激素\n" + new Array(5).fill("正文内容章节。").join("")
    const recs = chunkMarkdown({ ...base, body }, { maxChars: 1200, overlap: 150, minLen: 0 })
    expect(recs[0].section).toContain("指南")
    expect(recs[0].section).toContain("健康")
    expect(recs[0].section).toContain("激素")
  })
})

describe("pointId", () => {
  it("point id = sha1(wiki_id:path:chunk_index) 的确定性 UUID，且随 chunk_index 变化", () => {
    const a1 = pointId("mtf-wiki", "guide/hrt.md", 0)
    const a2 = pointId("mtf-wiki", "guide/hrt.md", 0)
    const b = pointId("mtf-wiki", "guide/hrt.md", 1)
    const c = pointId("ftm-wiki", "guide/hrt.md", 0)
    expect(a1).toBe(a2) // 幂等
    expect(a1).not.toBe(b) // chunk_index 不同 → 不同点
    expect(a1).not.toBe(c) // wiki 不同 → 不同点
    // 合法 UUID 形态
    expect(a1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

// ==================== T2.3 补充（fixture 驱动的集成测试 + 边界） ====================

describe("parseFrontmatter：list 值（fixture）+ 边界", () => {
  it("dirty-article：内联 [..] 列表（含引号元素）与引号 author", () => {
    const { meta, body } = parseFrontmatter(fixture("dirty-article.md"))
    expect(meta.tags).toEqual(["mtf", "hrt", "激素", "pills"])
    expect(meta.authors).toEqual(["Alice", "Bob"])
    expect(meta.status).toBe("active")
    // 逗号串联（无方括号）不被当列表——parser 只把 `[...]` 解析为列表，其余留为字符串。
    expect(meta.commalist).toBe("one, two, three")
    // 正文从 `---` 结束符之后开始，且 body 已 trim
    expect(body.startsWith("<!-- 文件头部的编辑说明")).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })

  it("edge-cases：多行 YAML 数组不被解析为列表（documented 行为）", () => {
    const { meta } = parseFrontmatter(fixture("edge-cases.md"))
    // `nested:` 后跟缩进数组行——当前 parser 按逐行 key:value 解析，
    // 只吃 `[a, b]` 内联；多行数组不被支持，`nested` 落空串。
    expect(meta.nested).toBe("")
    expect(meta.nested).not.toEqual(["多行", "数组"])
    // 空值 key 保留空串
    expect(meta.empty).toBe("")
    // `- 行` 不含 `:`，被逐行解析跳过（既不被收纳也不再进入后续行）
    expect(meta["-"]).toBeUndefined()
  })

  it("无 frontmatter：meta 空、body 为全文（no-frontmatter fixture）", () => {
    const { meta, body } = parseFrontmatter(fixture("no-frontmatter.md"))
    expect(meta).toEqual({})
    expect(body).toContain("本文用于断言 chunk 记录")
  })
})

describe("cleanBody：fixture 驱动", () => {
  it("dirty-article：去掉 shortcode、HTML 注释、折叠多余空行", () => {
    const out = cleanBody(fixture("dirty-article.md"))
    expect(out).not.toContain("{{<")
    expect(out).not.toContain("{{%")
    expect(out).not.toContain("<!--")
    expect(out).not.toContain("文件头部的编辑说明")
    expect(out).not.toContain("这是注释")
    expect(out).not.toMatch(/\n{3,}/)
    // 保留的正文片段
    expect(out).toContain("用量说明")
    expect(out).toContain("副作用")
    expect(out).toContain("随访计划")
    expect(out).toContain("雌二醇")
  })
})

describe("buildDirMeta / resolvePathMeta：目录元映射", () => {
  const files = [
    { path: "_index.md", content: "---\ntitle: 根标题\n---\n" },
    { path: "guide/_index.md", content: "---\ntitle: 指南\n---\n" },
    // 用 fixtxe dir-index.md 作为 guide/health 的 _index（带多字段 frontmatter）
    { path: "guide/health/_index.md", content: fixture("dir-index.md") },
    { path: "guide/health/hrt.md", content: "---\ntitle: 激素\n---\n正文。" },
    { path: "guide/surgery.md", content: "---\ntitle: 手术\n---\n正文。" },
  ]
  const dirMeta = buildDirMeta(files)

  it("_index.md 的 title 映射到目录相对路径，并保留其余 meta", () => {
    expect(dirMeta["guide/health"].title).toBe("健康")
    // dir-index.md 携带列表类 meta，应一并进入映射
    expect(dirMeta["guide/health"].toc).toEqual(["hrt", "surgery", "mental"])
    expect(folderTitle("guide/health", "health", dirMeta)).toBe("健康")
  })

  it("resolvePathMeta：深层章节链（category/chapter 来自多级 _index）", () => {
    const m = resolvePathMeta("guide/health/hrt.md", dirMeta, null)
    expect(m.category).toBe("指南")
    expect(m.chapter).toBe("健康")
  })

  it("resolvePathMeta：无 _index 的目录回退到文件夹英文名作 category", () => {
    // 去掉 guide/_index 后，`guide` 无 _index → category 回退到文件夹名 "guide"
    const dirMetaNoGuide = buildDirMeta(files.filter((f) => f.path !== "guide/_index.md"))
    const m = resolvePathMeta("guide/surgery.md", dirMetaNoGuide, null)
    expect(m.category).toBe("guide")
    expect(m.chapter).toBeNull()
  })
})

describe("chunkMarkdownWithText：fixture 驱动 + 贪心合并 + 全字段断言", () => {
  const base = {
    wiki_id: "mtf-wiki",
    path: "guide/health/hrt.md",
    title: "激素治疗",
    section: { category: "指南", chapter: "健康" },
    url: "https://wiki.transhelper.org/mtf/guide/health/hrt.md",
    commit_sha: "abc123def",
    updated_at: "2026-09-07T00:00:00.000Z",
  }

  it("clean-article：每个 chunk 的 8 个字段全部有正确值", () => {
    const body = cleanBody(fixture("clean-article.md"))
    const items = chunkMarkdownWithText({ ...base, body }, { maxChars: 1200, overlap: 150, minLen: 0 })
    expect(items.length).toBeGreaterThan(0)
    for (const { record } of items) {
      expect(Object.keys(record).sort()).toEqual(
        ["chunk_index", "commit_sha", "path", "section", "title", "updated_at", "url", "wiki_id"].sort(),
      )
      expect(record.wiki_id).toBe("mtf-wiki")
      expect(record.path).toBe("guide/health/hrt.md")
      expect(record.title).toBeTruthy()
      expect(typeof record.title).toBe("string")
      expect(record.section).toContain("指南")
      expect(record.section).toContain("健康")
      expect(record.url).toBe("https://wiki.transhelper.org/mtf/guide/health/hrt.md")
      expect(record.commit_sha).toBe("abc123def")
      expect(record.updated_at).toBe("2026-09-07T00:00:00.000Z")
      expect(Number.isInteger(record.chunk_index)).toBe(true)
    }
    // chunk_index 从 0 起连续递增
    expect(items.map((x) => x.record.chunk_index)).toEqual(items.map((_, i) => i))
  })

  it("clean-article：标题分级 + 贪心合并，短章节不各成碎片", () => {
    const body = cleanBody(fixture("clean-article.md"))
    const items = chunkMarkdownWithText({ ...base, body }, { maxChars: 1200, overlap: 150, minLen: 0 })
    // 仅 6 个标题（1×h1 + 3×h2 + 2×h3），正文很短，整体应并入极少数 chunk
    // 贪心合并：相邻短章节应合并，而不是每个标题一个碎片。
    expect(items.length).toBeLessThan(6)
    // section 携带标题链：任一含 h2「内分泌治疗」的 chunk，其 section 应含该标题
    const texts = items.map((x) => x.text).join("\n")
    expect(texts).toContain("内分泌治疗")
    expect(texts).toContain("手术")
  })

  it("dirty-article：清洗后分块，fixture 中的短章节被贪心合并且字段齐全", () => {
    const body = cleanBody(fixture("dirty-article.md"))
    const items = chunkMarkdownWithText({ ...base, body }, { maxChars: 1200, overlap: 150, minLen: 0 })
    expect(items.length).toBeGreaterThan(0)
    // 短章节（用量说明/副作用/随访计划）应被贪心合并，而不是 3 个独立碎片
    expect(items.length).toBeLessThan(5)
    const whole = items.map((x) => x.text).join("\n")
    expect(whole).not.toContain("{{<")
    expect(whole).not.toContain("<!--")
    for (const { record } of items) {
      expect(record.wiki_id).toBe("mtf-wiki")
      expect(record.section).toContain("指南")
    }
  })

  it("空正文 / 全空白标题：返回空数组或仅 preamble", () => {
    // 空 body（< minLen）
    expect(chunkMarkdown({ ...base, body: "" }, { maxChars: 1200, overlap: 150, minLen: 0 })).toEqual([])
    // 大量空白但无内容 → 清洗后为空 → 空数组
    expect(chunkMarkdown({ ...base, body: "\n\n\n   \n" }, { maxChars: 1200, overlap: 150, minLen: 0 })).toEqual([])
    // 全空白标题行会被 `^#{1,6}\s+` 吃掉（require 至少一个空白），整行 whitespace 标题不成立
    const body = "# 正常\n正文。\n"
    const items = chunkMarkdownWithText({ ...base, body }, { maxChars: 1200, overlap: 150, minLen: 0 })
    expect(items.length).toBe(1)
    expect(items[0].text).toContain("正文")
  })
})

describe("无 frontmatter 走 chunk 全流程", () => {
  it("no-frontmatter：meta 空但 chunk 字段仍完整", () => {
    const { meta, body } = parseFrontmatter(fixture("no-frontmatter.md"))
    expect(meta).toEqual({})
    const base = {
      wiki_id: "mtf-wiki",
      path: "p.md",
      title: "p.md",
      section: { category: null, chapter: null },
      url: "https://wiki.transhelper.org/p",
      commit_sha: "sha",
      updated_at: "2026-09-07T00:00:00.000Z",
    }
    const items = chunkMarkdownWithText({ ...base, body }, { maxChars: 1200, overlap: 150, minLen: 0 })
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].record.path).toBe("p.md")
    expect(items[0].record.title).toBe("p.md")
    expect(items[0].record.section).toBe("")
  })
})
