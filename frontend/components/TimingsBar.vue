<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 检索耗时状态条（TimingsBar）
     - **默认只显示「总耗时 3.17s」**（+ 命中缓存徽章），点击才展开现有拆解（布局改造 2026-09-12）
     - 展开状态**不持久化**：每次检索先看总耗时，要细看时点一下即可 -->
<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-sub" aria-label="检索耗时指标">
    <!-- 收起态：总耗时（按钮，点击展开/收起拆解） -->
    <button
      type="button"
      class="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:text-ink-title"
      :aria-expanded="open"
      aria-controls="prism-timings-detail"
      @click="open = !open"
    >
      <span class="font-medium text-ink-title">总耗时</span>
      <span class="font-mono font-medium tabular-nums text-ink-title">{{ totalText }}</span>
      <svg
        class="h-3 w-3 text-ink-muted transition-transform"
        :class="open ? 'rotate-180' : ''"
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

    <!-- 展开态：现有拆解（文本嵌入 / 向量检索 / 精细重排 / 伴读总结 / 总计） -->
    <span v-if="open" id="prism-timings-detail" class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <template v-for="(m, i) in metrics" :key="m.label">
        <span v-if="i > 0" class="select-none text-surface-border" aria-hidden="true">•</span>
        <span class="inline-flex items-baseline gap-1">
          <span>{{ m.label }}</span>
          <span class="font-mono font-medium tabular-nums text-ink-title">{{ m.ms }}</span>
        </span>
      </template>
    </span>

    <!-- 命中缓存：**弱样式徽章**（中性描边 + 小一号字，不再用绿色实底抢视线 —— 截图反馈 #4） -->
    <span
      v-if="timings.cached"
      class="ml-1 inline-flex items-center rounded border border-surface-border bg-canvas-subtle px-1.5 py-0.5 text-[10px] font-normal text-ink-muted"
    >
      命中缓存
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import type { SearchTimings } from "~/composables/useApi"

const props = defineProps<{ timings: SearchTimings }>()

/** 拆解默认收起（每次检索后仍是收起态，不持久化、不记忆） */
const open = ref(false)

const fmt = (ms?: number) =>
  ms == null || Number.isNaN(ms) ? "-" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`

/** 收起态显示的「总耗时」（数值格式与拆解里的 fmt() 完全一致） */
const totalText = computed(() => fmt(props.timings.total_ms))

const metrics = computed(() => {
  const list = [
    { label: "文本嵌入", ms: fmt(props.timings.embed_ms) },
    { label: "向量检索", ms: fmt(props.timings.search_ms) },
  ]
  if (props.timings.rerank_ms > 0) list.push({ label: "精细重排", ms: fmt(props.timings.rerank_ms) })
  if (props.timings.llm_ms > 0) list.push({ label: "伴读总结", ms: fmt(props.timings.llm_ms) })
  list.push({ label: "总计", ms: fmt(props.timings.total_ms) })
  return list
})
</script>
