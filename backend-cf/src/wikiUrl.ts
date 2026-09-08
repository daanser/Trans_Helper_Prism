// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 各 wiki 官网阅读 URL 生成器（ingest 期，把原文 url 存成官网地址）
// 数据侧不再存 GitHub blob，而是把每个 chunk 的 url 存成 wiki 官网的可分享/可读地址，
// 前端“查阅官方原文”直接指向官网。不同 wiki 的构建链/URL 规则差异极大，须按 wiki 专属逻辑生成。
//
// 输入统一取：repoRootPath（repo 相对路径，含 content_dir 前缀）与 contentDirRel（相对 content_dir 的路径）、
// frontmatter meta（含 slug，FTM 等 Hugo 站用 slug 覆盖文件名）。
// 各类目规则依据用户实测样例（见 wikiUrl.test.ts）：
//   mtf: contentDirRel=docs/medicine/zero-to-hrt.md → mtf.wiki/zh-cn/docs/medicine/zero-to-hrt
//   ftm: contentDirRel=hrt/hrt-overview.md (+slug=overview) → ftm.wiki/zh-cn/hrt/overview/  （Hugo）
//   rle: contentDirRel=campus/UESTC.md → rle.wiki/campus/UESTC
//   mio: contentDirRel=hrt-lifespan-myth.md → mio.chengxi.moe/MioMtFWiki/hrt-lifespan-myth.html（GitHub Pages 静态 html）

/** frontmatter meta 的透传类型（与 parser.FrontmatterMeta 兼容）。 */
interface MetaLike {
  [key: string]: unknown
}

/** 生成器的输入。 */
export interface SiteUrlInput {
  /** repo 相对路径，含 content_dir 前缀（如 content/hrt/hrt-overview.md）。 */
  repoRootPath: string
  /** 相对 content_dir 的路径（如 hrt/hrt-overview.md / docs/medicine/zero-to-hrt.md）。 */
  contentDirRel: string
  /** 解析后的 frontmatter meta（含 slug 等）。 */
  meta?: MetaLike
}

/** 简单标量辅助：meta 里取字符串值。 */
function metaStr(meta: MetaLike | undefined, key: string): string | undefined {
  const v = meta?.[key]
  return typeof v === "string" ? v.trim() : undefined
}

/** 路径是否指向 index 文件（_index.md / index.md）。 */
function isIndex(file: string): boolean {
  return /(^|\/)index\.md$/i.test(file) || /(^|\/)_index\.md$/i.test(file)
}

/** 去 .md 后缀的叶子文件名（不含目录）。 */
function leafName(rel: string): string {
  const p = rel.split("/").pop() ?? rel
  return p.replace(/\.md$/i, "").replace(/^_?index$/, "")
}

/** 目录段（不含叶子文件名），POSIX 无首尾斜杠。 */
function dirPath(rel: string): string {
  const parts = rel.split("/")
  parts.pop()
  return parts.join("/")
}

/** 拼接多段为 URL（自动去掉多余前导斜杠，保留空段）。 */
function joinUrl(base: string, segments: string[]): string {
  const trimmed = segments
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter((s) => s.length > 0)
  return trimmed.length ? `${base}/${trimmed.join("/")}` : base
}

// ── per-wiki 规则 ──

/** MtF：content/zh-cn/docs/X.md → mtf.wiki/zh-cn/docs/X（去 .md，无尾斜杠）。 */
function mtfUrl(input: SiteUrlInput): string {
  // contentDirRel = docs/...（相对 content/zh-cn）
  const rel = input.contentDirRel
  if (isIndex(rel)) {
    // _index.md → 目录本身：zh-cn/{dir}
    return joinUrl("https://mtf.wiki", ["zh-cn", dirPath(rel)])
  }
  return joinUrl("https://mtf.wiki", ["zh-cn", rel.replace(/\.md$/i, "")])
}

/** FtM（Hugo）：content/.../X.md → ftm.wiki/zh-cn/{dir}/{slug|名}/，表尾斜杠目录式。 */
function ftmUrl(input: SiteUrlInput): string {
  const rel = input.contentDirRel
  const dir = dirPath(rel)
  if (isIndex(rel)) {
    // _index.md → 目录本身 + 尾斜杠
    return `${joinUrl("https://ftm.wiki", ["zh-cn", dir])}/`
  }
  const slug = metaStr(input.meta, "slug")
  const name = slug && slug.length > 0 ? slug : leafName(rel)
  return `${joinUrl("https://ftm.wiki", ["zh-cn", dir, name])}/`
}

/** RLE：docs/X.md → rle.wiki/X（无语言前缀、无尾斜杠、去 .md）。 */
function rleUrl(input: SiteUrlInput): string {
  const rel = input.contentDirRel
  if (isIndex(rel)) {
    return joinUrl("https://rle.wiki", [dirPath(rel)])
  }
  return joinUrl("https://rle.wiki", [rel.replace(/\.md$/i, "")])
}

/** Mio（GitHub Pages 静态）：docs/X.md → mio.chengxi.moe/MioMtFWiki/X.html（md→html）。 */
function mioUrl(input: SiteUrlInput): string {
  const rel = input.contentDirRel
  if (isIndex(rel)) {
    // index → 目录 index.html
    const base = dirPath(rel)
    return joinUrl("https://mio.chengxi.moe", ["MioMtFWiki", base, "index.html"])
  }
  const html = rel.replace(/\.md$/i, "") + ".html"
  return joinUrl("https://mio.chengxi.moe", ["MioMtFWiki", html])
}

const RULES: Record<string, (i: SiteUrlInput) => string> = {
  "mtf-wiki": mtfUrl,
  "ftm-wiki": ftmUrl,
  "rle-wiki": rleUrl,
  miomtfwiki: mioUrl,
}

/**
 * 生成某 wiki 的官网阅读 URL。
 * - 未注册 wiki：回退为 GitHub blob 形式（保持行为）。
 * - 输入 url 已含官网域名的场景由调用方判断是否需要（ingest 期始终走本函数）。
 */
export function buildSiteUrl(wikiId: string, input: SiteUrlInput): string {
  const rule = RULES[wikiId]
  return rule ? rule(input) : `https://github.com/${repoOf(wikiId)}/blob/${input.repoRootPath}`
}

/** 已注册的 wiki id 集合（供调用方判断是否走官网生成）。 */
export function hasUrlRule(wikiId: string): boolean {
  return wikiId in RULES
}

/** 兜底用 repo 路径（仅在未注册规则时用到）。 */
function repoOf(_wikiId: string): string {
  return "unknown-repo"
}