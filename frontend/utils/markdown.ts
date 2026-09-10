// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — AI 回答的 Markdown 渲染（markdown-it，安全配置）
//
// ── 安全边界（改动前先读）──
// 1. `html: false`：模型输出里的**任何原始 HTML 都当纯文本转义**，这是防 XSS 的第一道（也是主要）闸门；
// 2. 链接统一加 `target="_blank"` + `rel="noopener noreferrer"`；markdown-it 默认的 `validateLink`
//    已拦掉 `javascript:` / `vbscript:` / 危险 `data:` 等协议；
// 3. 输出 HTML **只由 markdown-it 自己的 renderer 生成**（标签集合固定），所以组件里可以安全 `v-html`；
// 4. `[来源n]` 被转成 `<button class="prism-cite" data-cite="n">`，由组件用**事件委托**接住点击
//    —— 不生成内联事件处理器；
// 5. 渲染器异常一律吞掉并退化为纯文本转义（流式输入随时可能不完整）。
import MarkdownIt from "markdown-it"

/** 单例：配置固定，无需每次重建。 */
export const md = new MarkdownIt({
  html: false, // ← 安全关键项，别改
  linkify: true, // 裸 URL 自动成链
  breaks: true, // 流式回答里单换行即换行，更贴近模型输出习惯
  typographer: false,
})

// 外链：新窗口打开 + noopener
const linkOpen = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank")
  tokens[idx].attrSet("rel", "noopener noreferrer")
  return linkOpen ? linkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
}

/** `[来源n]` / `[来源 n]`（n 为 1–3 位数字）。 */
const CITE_RE = /^\[来源\s*(\d{1,3})\s*\]/

// 自定义行内规则：把 `[来源n]` 变成可点击的引用按钮（保留既有回跳交互）
md.inline.ruler.before("link", "prism_cite", (state, silent) => {
  const m = CITE_RE.exec(state.src.slice(state.pos))
  if (!m) return false
  if (!silent) {
    const token = state.push("prism_cite", "", 0)
    token.content = m[1]
  }
  state.pos += m[0].length
  return true
})

md.renderer.rules.prism_cite = (tokens, idx) => {
  const n = md.utils.escapeHtml(tokens[idx].content)
  return `<button type="button" class="prism-cite" data-cite="${n}">[来源${n}]</button>`
}

/**
 * 把 AI 回答渲染成**安全 HTML**（配合组件的 `v-html`）。
 * 空输入返回 `""`；渲染异常退化为纯文本转义（绝不向上抛）。
 */
export function renderAnswer(text: string | undefined | null): string {
  if (!text) return ""
  try {
    return md.render(text)
  } catch {
    return `<p>${md.utils.escapeHtml(text)}</p>`
  }
}
