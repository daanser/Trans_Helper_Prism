<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 检索耗时状态条（TimingsBar）
     - 清晰明了的中文指标展示，自然友好的视觉层级 -->
<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-sub" aria-label="检索耗时指标">
    <span class="font-medium text-ink-title">耗时拆解：</span>

    <template v-for="(m, i) in metrics" :key="m.label">
      <span v-if="i > 0" class="text-surface-border select-none" aria-hidden="true">•</span>
      <span class="inline-flex items-baseline gap-1">
        <span>{{ m.label }}</span>
        <span class="font-mono font-medium tabular-nums text-ink-title">{{ m.ms }}</span>
      </span>
    </template>

    <span
      v-if="timings.cached"
      class="ml-1.5 inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
    >
      命中缓存
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { SearchTimings } from "~/composables/useApi"

const props = defineProps<{ timings: SearchTimings }>()

const fmt = (ms?: number) =>
  ms == null || Number.isNaN(ms) ? "-" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`

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
