<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 搜索结果卡片（HitCard）
     - 人文与专业并重，层次分明的卡片阅览体验
     - 统一中性知识库徽章（彻底去除四个彩色），清晰自然的中文信息排版
     - **摘要默认折叠 4 行**（line-clamp），点「展开全文」看完整片段与底部操作行（布局改造 2026-09-12）
     - `id="hit-<id>"` 是 AI 引用回跳的锚点，**必须保留** -->
<template>
  <article
    :id="`hit-${hit.id}`"
    class="group rounded-xl border border-surface-border bg-surface p-5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-surface-border-hover hover:shadow-card-hover sm:p-6"
    :class="highlight ? 'ring-2 ring-primary border-primary' : ''"
  >
    <!-- 头部信息行：统一中性知识库徽章 + 路径 + 匹配度打分 -->
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <!-- 知识库来源标签（统一中性优雅灰白标，无多余彩色） -->
      <span class="inline-flex items-center rounded-md border border-surface-border bg-canvas-subtle px-2.5 py-0.5 text-xs font-medium text-ink-title">
        {{ displaySource }}
      </span>

      <!-- 章节文档路径 -->
      <span
        v-if="hit.path"
        class="min-w-0 max-w-xs truncate text-xs text-ink-muted sm:max-w-md"
        :title="hit.path"
      >
        {{ hit.path }}
      </span>

      <!-- 匹配度评分 -->
      <div class="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
        <span class="rounded bg-canvas-subtle px-1.5 py-0.5 text-[11px] text-ink-sub">
          {{ hit.rerank_score != null ? "语义重排" : "向量匹配" }}
        </span>
        <span class="font-mono font-semibold tabular-nums text-ink-title">
          {{ pctText }}
        </span>
      </div>
    </div>

    <!-- 文档标题：主要视觉重心 -->
    <h3 class="text-base font-semibold leading-snug text-ink-title sm:text-lg">
      <a
        :href="hit.url"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 transition-colors hover:text-primary"
      >
        <span>{{ plainTitle }}</span>
        <svg class="h-4 w-4 shrink-0 text-ink-muted transition-colors group-hover:text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>
    </h3>

    <!-- 原文片段：默认只显示 4 行（line-clamp-4，Tailwind 3.4 内置），点标题行右侧的「展开全文」看完整片段 -->
    <div
      v-if="richSnippet"
      :id="`hit-snippet-${hit.id}`"
      class="snippet-reading mt-3 rounded-lg bg-canvas-subtle/60 p-3.5"
      :class="expanded ? '' : 'line-clamp-4'"
      v-html="richSnippet"
    />
    <p v-else class="mt-2 text-xs text-ink-muted">暂无提取正文</p>

    <!-- 展开 / 收起（摘要够长时才出现，避免短摘要上挂一个死按钮） -->
    <button
      v-if="canExpand"
      type="button"
      class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-hover hover:underline"
      :aria-expanded="expanded"
      :aria-controls="`hit-snippet-${hit.id}`"
      @click="expanded = !expanded"
    >
      <span>{{ expanded ? "收起" : "展开全文" }}</span>
      <svg
        class="h-3 w-3 transition-transform"
        :class="expanded ? 'rotate-180' : ''"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <!-- 卡片底部：文档查阅操作（展开全文后出现） -->
    <div v-if="expanded" class="mt-4 flex items-center justify-between border-t border-surface-border pt-3 text-xs">
      <span class="font-mono text-[11px] text-ink-muted">
        编号 #{{ hit.id.slice(0, 8) }}
      </span>

      <a
        :href="hit.url"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 font-medium text-primary transition-colors hover:text-primary-hover hover:underline"
      >
        <span>查阅官方原文</span>
        <span aria-hidden="true">→</span>
      </a>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import type { SearchHit } from "~/composables/useApi"
import { SNIPPET_COLLAPSE_CHARS, renderSnippetMarkdown, stripLeadingTitle, stripMarkdown, truncateAtBoundary } from "~/utils/renderSnippet"

const props = defineProps<{
  hit: SearchHit
  query?: string
  highlight?: boolean
}>()

/**
 * 摘要折叠状态（默认折叠）。
 * **判定"要不要给展开按钮"用纯文本长度**（不用 offsetHeight 量 DOM）：
 * 逐条渲染时量 DOM 会触发同步布局（几十条结果 = 几十次 reflow），且首屏 SSR 量不到。
 */
const expanded = ref(false)

const plainTitle = computed(() => stripMarkdown(props.hit.title ?? "") || "未命名文档")

/**
 * 摘要原文：**去掉开头与标题重复的那一行**（截图反馈 #1：卡片已有大标题，
 * 摘要第一行又是同一个标题 —— wiki 的 chunk 常以页面标题开头）。
 */
const snippetSource = computed(() => stripLeadingTitle(props.hit.snippet ?? "", plainTitle.value))

/** 折叠态在句末标点处截断（截图反馈 #2：不要从《性别鉴定证…》中间断开） */
const collapsedSource = computed(() => truncateAtBoundary(snippetSource.value, SNIPPET_COLLAPSE_CHARS))

const plainSnippet = computed(() => stripMarkdown(snippetSource.value).trim())
/** 只有"完整摘要确实比折叠版长"时才给展开按钮（避免短摘要挂一个死按钮） */
const canExpand = computed(() => plainSnippet.value.length > collapsedSource.value.length)

const richSnippet = computed(() =>
  renderSnippetMarkdown(expanded.value ? snippetSource.value : collapsedSource.value, props.query ?? ""),
)

const pct = computed(() => Math.max(0, Math.min(100, (props.hit.rerank_score ?? props.hit.score ?? 0) * 100)))
const pctText = computed(() => pct.value.toFixed(1) + "%")

const s = computed(() => (props.hit.source || "").toLowerCase())

const displaySource = computed(() => {
  if (s.value.includes("mtf") && !s.value.includes("mio")) return "MtF Wiki"
  if (s.value.includes("ftm")) return "FtM Wiki"
  if (s.value.includes("rle")) return "RLE Wiki"
  if (s.value.includes("mio")) return "Mio MtF"
  return props.hit.source || "知识库"
})
</script>
