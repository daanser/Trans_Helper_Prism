// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — 搜索结果 snippet 轻量渲染
// 自研 markdown 子集渲染（零依赖，T0.5 最小栈）：只覆盖 snippet 需要的子集——
// 标题（含 `{#custom-anchor}` 剥离，只取文字）、加粗/斜体/删除线、行内代码、
// 链接（只保留文字 + 可点）、图片（只保留 alt 文字，不加载外链图）、
// 列表、引用、表格（简化）、代码块（纯文本块）、分割线。
//
// 安全模型（防 XSS）：
// 1. 转义优先——先对全文做 HTML 转义，之后只通过白名单拼接我们自己生成的标签
//    （p/div/strong/em/del/code/pre/a/ul/ol/li/blockquote/table/thead/tbody/tr/th/td/br/mark/hr）。
// 2. 原文里的任何 HTML（含 <script>/<img onerror> 等）都会被转义成纯文本，永不执行。
// 3. 链接 href 只允许 http(s)/站内相对路径/锚点/mailto，其余 scheme（javascript:/data:/vbscript: 等）
//    一律降级为纯文字；URL 中的引号已被转义，不可能打破属性边界。
// 4. 高亮 <mark> 只作用于文本节点，绝不在标签/属性内部插入。

/** 允许的链接 scheme：外链 http(s)、站内相对路径、页内锚点、mailto */
const ALLOWED_HREF = /^(https?:\/\/|\/[^/]|#[^"'\s]*$|mailto:)/i
const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file|blob):/i

/** 纯装饰性的短码残留（Hugo shortcode 理论上 ingest 时已去掉，这里做兜底） */
const SHORTCODE_LINE = /^\s*\{\{[<%][\s\S]*[>%]\}\}\s*$/

/** `{#anchor}` / `{ #anchor }` */
const ANCHOR_RE = /\{\s*#[A-Za-z0-9\-_:.]+\s*\}/g

/** 脚注引用 `[^1]`：snippet 里只显示正文，去掉 */
const FOOTNOTE_REF_RE = /\[\^[^\]]*\]/g

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 行内 code span 占位符（控制字符，正常文本里不会出现） */
const CODE_PH = "\u0001"
const CODE_PH_END = "\u0002"

function sanitizeHref(raw: string): string | null {
  // raw 已经过 escapeHtml；先把 &amp; 还原再做 scheme 判断
  const url = raw.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  if (DANGEROUS_SCHEME.test(url)) return null
  if (ALLOWED_HREF.test(url)) return raw
  // 裸相对路径（wiki 内链如 `术后护理` / `../x`）：不含空白与引号即放行
  if (/^[^\s"'<>]+$/.test(url)) return raw
  return null
}

/** 行内渲染：输入为原文单行（未转义），输出为安全 HTML 片段 */
function renderInline(src: string): string {
  // 1) 转义优先
  let t = escapeHtml(src)

  // 2) 剥离 {#anchor}、脚注引用
  t = t.replace(ANCHOR_RE, "").replace(FOOTNOTE_REF_RE, "")

  // 3) 行内代码先抽出来，避免内部的 * _ ~ [ 被误解析
  const codes: string[] = []
  t = t.replace(/`([^`\n]+?)`/g, (_m, inner: string) => {
    codes.push(`<code>${inner}</code>`)
    return `${CODE_PH}${codes.length - 1}${CODE_PH_END}`
  })

  // 4) 图片只保留 alt 文字（不加载任何外链资源）
  t = t.replace(/!\[([^\]]*?)\]\([^)]*?\)/g, "$1")

  // 5) 链接：保留文字 + 可点（非法 scheme 降级为纯文字）。
  //    URL 允许一层内嵌括号（如 javascript:alert(1)），以便整体识别并丢弃，不残留半个括号。
  t = t.replace(
    /\[([^\]]*?)\]\(\s*([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+&quot;[^&]*?&quot;)?\s*\)/g,
    (_m, text: string, href: string) => {
      const safe = sanitizeHref(href)
      if (safe) return `<a href="${safe}" target="_blank" rel="noopener">${text || safe}</a>`
      return text
    },
  )
  // 残留的引用式链接 `[文字][ref]` / `[文字]`：只取文字
  t = t.replace(/\[([^\]]+?)\](?:\[[^\]]*?\])?/g, "$1")

  // 6) 加粗 / 斜体 / 删除线（先三重再双重再单重，避免嵌套误吞）
  t = t.replace(/\*\*\*([\s\S]+?)\*\*\*/g, "<strong><em>$1</em></strong>")
  t = t.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
  t = t.replace(/__([\s\S]+?)__/g, "<strong>$1</strong>")
  t = t.replace(/~~([\s\S]+?)~~/g, "<del>$1</del>")
  // 单个 * / _ 包裹： opening 前不能是 * _ 或词字符（防 2*3*4 / snake_case 误杀），
  // closing 后同样要求，避免吞掉半个词；全角标点（，。等）两侧正常识别。
  t = t.replace(/(^|[^*_\w\u4e00-\u9fff])\*([^*\s][^*]*?)\*(?![*_\w\u4e00-\u9fff])/g, "$1<em>$2</em>")
  t = t.replace(/(^|[^*_\w\u4e00-\u9fff])_([^_\s][^_]*?)_(?![_*0-9a-zA-Z\u4e00-\u9fff])/g, "$1<em>$2</em>")

  // 7) 还原行内代码
  t = t.replace(new RegExp(`${CODE_PH}(\\d+)${CODE_PH_END}`, "g"), (_m, i: string) => codes[Number(i)] ?? "")

  return t
}

function isTableSeparator(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|")
  return cells.length > 0 && cells.every((c) => /^[\s:]*-{1,}[\s:]*$/.test(c))
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
}

function renderTable(header: string[], aligns: string[], rows: string[][]): string {
  const ths = header
    .map((h, i) => `<th${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${renderInline(h)}</th>`)
    .join("")
  const trs = rows
    .map(
      (r) =>
        `<tr>${header.map((_, i) => `<td${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${renderInline(r[i] ?? "")}</td>`).join("")}</tr>`,
    )
    .join("")
  return `<div class="sn-table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`
}

/**
 * 把后端返回的 snippet（标准 markdown + {#anchor}）渲染为安全 HTML。
 * @param src 后端 snippet 原文
 * @param query 当前搜索词（可选）：命中关键词会被 <mark> 高亮
 */
export function renderSnippetMarkdown(src: string, query = ""): string {
  if (!src) return ""
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let i = 0

  // 段落行缓存：连续普通行合并为一个 <p>，行间用 <br>
  let para: string[] = []
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(renderInline).join("<br>")}</p>`)
      para = []
    }
  }

  // 列表项缓存
  let list: { ordered: boolean; items: string[] } | null = null
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul"
      out.push(`<${tag}>${list.items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</${tag}>`)
      list = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 空行：断段落/列表
    if (!trimmed) {
      flushPara()
      flushList()
      i++
      continue
    }

    // Hugo shortcode 残留兜底：整行丢弃
    if (SHORTCODE_LINE.test(line)) {
      i++
      continue
    }

    // 代码块 ``` / ~~~
    const fence = trimmed.match(/^(```|~~~)/)
    if (fence) {
      flushPara()
      flushList()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
        code.push(lines[i])
        i++
      }
      i++ // 跳过结束 fence（缺失则直接到末尾）
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`)
      continue
    }

    // ATX 标题：只取文字，{#anchor} 由行内阶段剥离；snippet 内降级为加粗段落
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushPara()
      flushList()
      const text = heading[2].replace(/\s+#+\s*$/, "").replace(ANCHOR_RE, "").replace(/\s+/g, " ").trim()
      out.push(`<p class="sn-heading">${renderInline(text)}</p>`)
      i++
      continue
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara()
      flushList()
      out.push("<hr>")
      i++
      continue
    }

    // 引用块：连续 > 行合并
    if (/^>\s?/.test(trimmed)) {
      flushPara()
      flushList()
      const quotes: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quotes.push(lines[i].trim().replace(/^>\s?/, ""))
        i++
      }
      out.push(`<blockquote>${quotes.map(renderInline).join("<br>")}</blockquote>`)
      continue
    }

    // 表格：表头 + 分隔行 + 数据行
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara()
      flushList()
      const header = splitRow(trimmed)
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim()
        if (t.startsWith(":") && t.endsWith(":")) return "center"
        if (t.endsWith(":")) return "right"
        if (t.startsWith(":")) return "left"
        return ""
      })
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim().includes("|") && rows.length < 30) {
        rows.push(splitRow(lines[i]))
        i++
      }
      out.push(renderTable(header, aligns, rows))
      continue
    }

    // 列表项：- * + 或 1.
    const item = trimmed.match(/^([-*+])\s+(.*)$/)
    const oitem = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (item || oitem) {
      flushPara()
      const ordered = Boolean(oitem)
      const text = (item?.[2] ?? oitem?.[1] ?? "").replace(/^\[[ xX]\]\s+/, "")
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(text)
      i++
      continue
    }

    // 普通段落行
    flushList()
    para.push(trimmed)
    i++
  }
  flushPara()
  flushList()

  let html = out.join("")

  // query 关键词高亮：只作用于文本节点，不碰标签/属性
  const terms = query
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 || /[\u4e00-\u9fff]/.test(s))
    .sort((a, b) => b.length - a.length)
  if (terms.length) {
    const escapedTerms = terms.map((t) => escapeHtml(t)).map(escapeRegExp)
    const re = new RegExp(`(${escapedTerms.join("|")})`, "g")
    html = html
      .split(/(<[^>]*>)/g)
      .map((seg) => (seg.startsWith("<") ? seg : seg.replace(re, "<mark>$1</mark>")))
      .join("")
  }

  return html
}

/**
 * 剥离 markdown 修饰得到纯文本（用于标题等纯文本插值场景，Vue 会自动转义）。
 */
export function stripMarkdown(src: string): string {
  if (!src) return ""
  return src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(ANCHOR_RE, "")
    .replace(FOOTNOTE_REF_RE, "")
    .replace(/!\[([^\]]*?)\]\([^)]*?\)/g, "$1")
    .replace(/\[([^\]]*?)\]\([^)]*?\)/g, "$1")
    .replace(/`([^`]*?)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*\*|\*\*|__|\*|_|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
