<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — AI 伴读卡片（AiCompanionCard）
     - 流式渲染 POST /api/v1/search/stream 的增量文本（tasks.md T3.4）
     - 正文中的 `[来源n]` 渲染为可点击引用，点击回跳对应命中卡片
     - 追问面板：同一 session_id 多轮（桌面右栏 / 移动端结果上方） -->
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
        <span
          v-if="statusLabel"
          class="rounded px-1.5 py-0.5 text-[10px] font-medium"
          :class="statusClass"
        >
          {{ statusLabel }}
        </span>
      </div>
      <span v-if="model" class="max-w-[8rem] truncate font-mono text-xs text-ink-muted" :title="model">{{ model }}</span>
    </div>

    <p v-if="!answer && !streaming && !notice" class="mb-3 text-xs leading-relaxed text-ink-sub">
      结合本次检索命中的文献，为你提炼要点并标注可点击的引用来源。在搜索面板打开「AI 伴读」开关即可使用，每次总结与追问都会消耗配额。
    </p>

    <!-- 流式骨架屏 -->
    <div v-if="streaming && !answer" class="animate-pulse space-y-2.5 py-2">
      <div class="h-3.5 rounded bg-canvas-subtle"></div>
      <div class="h-3.5 w-5/6 rounded bg-canvas-subtle"></div>
      <div class="h-3.5 w-2/3 rounded bg-canvas-subtle"></div>
    </div>

    <!-- 结论正文（流式增量渲染；[来源n] 可点击） -->
    <div v-if="answer" class="text-xs leading-relaxed text-ink-body">
      <span class="whitespace-pre-wrap">
        <template v-for="(seg, i) in segments" :key="i">
          <button
            v-if="seg.kind === 'cite'"
            type="button"
            class="mx-0.5 inline-flex items-center rounded border border-surface-border bg-canvas-subtle px-1.5 py-px align-baseline text-[11px] font-medium text-primary transition-colors hover:border-primary"
            :title="`跳转到引用来源 ${seg.ref}`"
            @click="$emit('cite', seg.ref ?? '')"
          >
            {{ seg.text }}
          </button>
          <template v-else>{{ seg.text }}</template>
        </template>
      </span>
      <span v-if="streaming" class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-text-bottom"></span>
    </div>

    <!-- 不可用提示（后端 404/501 或上游全挂；绝不影响主检索） -->
    <div
      v-if="notice"
      class="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <span class="shrink-0 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-200">
        {{ streaming ? "重试中" : "提示" }}
      </span>
      <span>{{ notice }}</span>
    </div>

    <!-- 引用来源（后端显式给出 citations 时的兜底入口） -->
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

    <!-- 追问面板 -->
    <slot name="followup">
      <div v-if="followupEnabled" class="mt-4 border-t border-surface-border pt-3">
        <label class="mb-1.5 block text-xs font-medium text-ink-sub">
          继续追问（同一会话，按 token 扣减配额）
          <div class="mt-1.5 flex items-end gap-2">
            <textarea
              v-model="question"
              rows="2"
              :disabled="followupBusy"
              aria-label="继续追问"
              placeholder="例如：这些方案的禁忌症分别是什么？"
              class="min-h-[2.5rem] w-full resize-y rounded-lg border border-surface-border bg-canvas-subtle/60 px-2.5 py-2 text-xs leading-relaxed text-ink-body placeholder:text-ink-muted focus:border-primary focus:outline-none disabled:opacity-50"
              @keydown.enter.exact.prevent="send"
            />
            <button
              type="button"
              :disabled="followupBusy || !question.trim()"
              class="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
              @click="send"
            >
              {{ followupBusy ? "生成中…" : "追问" }}
            </button>
          </div>
        </label>
      </div>
    </slot>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"

interface Segment {
  kind: "text" | "cite"
  text: string
  ref?: string
}

const props = defineProps<{
  answer?: string
  citations?: string[]
  model?: string
  streaming?: boolean
  /** idle：尚未开启；streaming：流式生成中；done：已完成；unavailable：后端未实现/上游不可用 */
  status?: "idle" | "streaming" | "done" | "unavailable"
  /** 不可用/降级提示文案 */
  notice?: string
  followupBusy?: boolean
  /** 是否显示追问面板（仅 AI 伴读开启且有结果时） */
  followupEnabled?: boolean
}>()

const emit = defineEmits<{
  (e: "cite", ref: string): void
  (e: "followup", question: string): void
}>()

const question = ref("")

const statusLabel = computed(() => {
  switch (props.status) {
    case "streaming":
      return "生成中"
    case "done":
      return "已生成"
    case "unavailable":
      return "不可用"
    case "idle":
      return "未开启"
    default:
      return ""
  }
})

const statusClass = computed(() => {
  switch (props.status) {
    case "streaming":
      return "bg-primary-subtle text-primary"
    case "done":
      return "bg-canvas-subtle text-ink-sub"
    case "unavailable":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
    default:
      return "bg-canvas-subtle text-ink-muted"
  }
})

/** 把正文切成文本 / `[来源n]` 引用两类片段（流式追加时保持稳定 key） */
const segments = computed<Segment[]>(() => {
  const text = props.answer ?? ""
  if (!text) return []
  const out: Segment[] = []
  const re = /\[来源\s*(\d+)\]/g
  let last = 0
  let match = re.exec(text)
  while (match) {
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) })
    out.push({ kind: "cite", text: match[0], ref: match[1] })
    last = match.index + match[0].length
    match = re.exec(text)
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) })
  return out
})

function send() {
  const q = question.value.trim()
  if (!q || props.followupBusy) return
  emit("followup", q)
  question.value = ""
}
</script>
