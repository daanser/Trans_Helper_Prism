<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — AI 伴读总结卡片（AiCompanionCard）
     - 人文与专业并重，优雅的学术助手视窗 -->
<template>
  <div class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card lg:sticky lg:top-20">
    <div class="mb-3 flex items-center justify-between border-b border-surface-border pb-3">
      <div class="flex items-center gap-2">
        <div class="flex h-6 w-6 items-center justify-center rounded-md bg-primary-subtle text-primary">
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        </div>
        <h3 class="text-sm font-semibold text-ink-title">
          AI 伴读与要点总结
        </h3>
        <span class="rounded bg-canvas-subtle px-1.5 py-0.5 text-[10px] font-medium text-ink-sub">
          即将接入
        </span>
      </div>
      <span v-if="model" class="font-mono text-xs text-ink-muted">{{ model }}</span>
    </div>

    <p v-if="!answer && !streaming" class="mb-3 text-xs leading-relaxed text-ink-sub">
      结合检索命中的权威文献，为您提炼条目要点并提供引用追溯。可在搜索面板中打开「AI 伴读」开关开启体验。
    </p>

    <!-- 流式骨架屏 -->
    <div v-if="streaming && !answer" class="animate-pulse space-y-2.5 py-2">
      <div class="h-3.5 rounded bg-canvas-subtle"></div>
      <div class="h-3.5 w-5/6 rounded bg-canvas-subtle"></div>
      <div class="h-3.5 w-2/3 rounded bg-canvas-subtle"></div>
    </div>

    <!-- 结论正文 -->
    <div v-if="answer" class="whitespace-pre-wrap text-xs leading-relaxed text-ink-body">
      {{ answer }}
    </div>

    <!-- 引用来源 -->
    <div v-if="citations?.length" class="mt-4 flex flex-wrap items-center gap-1.5 border-t border-surface-border pt-3">
      <span class="text-xs text-ink-muted">条目引用：</span>
      <button
        v-for="c in citations"
        :key="c"
        type="button"
        class="rounded border border-surface-border bg-canvas-subtle px-2 py-0.5 text-xs text-primary transition-colors hover:border-primary"
        @click="$emit('cite', c)"
      >
        [{{ c }}]
      </button>
    </div>

    <!-- 追问插槽 -->
    <slot name="followup">
      <div v-if="!answer && !streaming" class="mt-3 rounded-xl border border-dashed border-surface-border bg-canvas-subtle/50 p-3 text-center">
        <span class="text-xs text-ink-muted">
          智能多轮追问通道 · 后端对接中
        </span>
      </div>
    </slot>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  answer?: string
  citations?: string[]
  model?: string
  streaming?: boolean
}>()

defineEmits<{
  (e: "cite", id: string): void
}>()
</script>
