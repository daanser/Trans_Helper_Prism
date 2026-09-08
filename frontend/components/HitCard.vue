<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 搜索结果卡片（HitCard）
     - 人文与专业并重，层次分明的卡片阅览体验
     - 统一中性知识库徽章（彻底去除四个彩色），清晰自然的中文信息排版
     - 明确的重点与高可读性 Markdown 摘要 -->
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

    <!-- 原文片段 -->
    <div
      v-if="richSnippet"
      class="snippet-reading mt-3 rounded-lg bg-canvas-subtle/60 p-3.5"
      v-html="richSnippet"
    />
    <p v-else class="mt-2 text-xs text-ink-muted">暂无提取正文</p>

    <!-- 卡片底部：文档查阅操作 -->
    <div class="mt-4 flex items-center justify-between border-t border-surface-border pt-3 text-xs">
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
import { computed } from "vue"
import type { SearchHit } from "~/composables/useApi"
import { renderSnippetMarkdown, stripMarkdown } from "~/utils/renderSnippet"

const props = defineProps<{
  hit: SearchHit
  query?: string
  highlight?: boolean
}>()

const plainTitle = computed(() => stripMarkdown(props.hit.title ?? "") || "未命名文档")
const richSnippet = computed(() => renderSnippetMarkdown(props.hit.snippet ?? "", props.query ?? ""))

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
