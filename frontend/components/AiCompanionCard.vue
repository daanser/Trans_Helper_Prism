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
      <div class="flex shrink-0 items-center gap-3">
        <span v-if="model" class="max-w-[8rem] truncate font-mono text-xs text-ink-muted" :title="model">{{ model }}</span>
        <!-- 主开关：AI 伴读唯一入口（搜索面板那边只做被动状态展示） -->
        <ToggleMini
          :model-value="active"
          label="AI 伴读"
          hide-label
          @update:model-value="(v: boolean) => emit('update:enabled', v)"
        />
      </div>
    </div>

    <p v-if="!answer && !streaming && !notice" class="mb-3 text-xs leading-relaxed text-ink-sub">
      <template v-if="active">
        <b>已开启</b>：检索后会自动提炼<b>要点</b>，并标注<b>可点击的引用来源</b>（点击可回跳原文）。
        每次总结与追问都会消耗配额，可用右上开关随时关闭。
      </template>
      <template v-else>
        结合本次检索命中的文献，提炼要点并标注可点击的引用来源。用右上开关打开「AI 伴读」即可使用；每次总结与追问都会消耗配额。
      </template>
    </p>

    <!-- 流式骨架屏 -->
    <div v-if="streaming && !answer" class="animate-pulse space-y-2.5 py-2">
      <div class="h-3.5 rounded bg-canvas-subtle"></div>
      <div class="h-3.5 w-5/6 rounded bg-canvas-subtle"></div>
      <div class="h-3.5 w-2/3 rounded bg-canvas-subtle"></div>
    </div>

    <!-- 结论正文：Markdown 渲染 + [来源n] 可点击 + **内部独立滚动**（不带动整页） -->
    <div
      v-if="answer"
      ref="scrollEl"
      class="ai-answer max-h-[58vh] overflow-y-auto overscroll-contain pl-1 pr-3 text-xs leading-relaxed text-ink-body lg:max-h-[calc(100vh-26rem)]"
      @click="onAnswerClick"
      @scroll.passive="onAnswerScroll"
    >
      <!-- eslint-disable-next-line vue/no-v-html -- 输出由 markdown-it(html:false) 生成，安全边界见 utils/markdown.ts 文件头 -->
      <div class="md" v-html="renderedAnswer"></div>
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

    <!-- AI 免责（plan-m4.md W5）：只要出现过 AI 内容就常驻一句，不藏在页脚 -->
    <p
      v-if="answer || streaming || notice"
      class="mt-3 border-t border-surface-border pt-2.5 text-[11px] leading-relaxed text-ink-muted"
    >
      内容由 AI 生成，<span class="font-medium text-ink-sub">可能出错或过时，不能替代医生建议</span>；
      请以 <span class="font-medium text-ink-sub">[来源n]</span> 指向的原文为准。
      <NuxtLink to="/about" class="text-primary hover:underline">了解详情</NuxtLink>
    </p>

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
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { renderAnswer } from "~/utils/markdown"
import ToggleMini from "./ToggleMini.vue"

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
  /**
   * AI 伴读开关状态（**单一数据源**：与搜索面板共用父组件同一个状态）。
   * 加这个 prop 之前，卡片只按 `status` 判断"未开启"，导致开关已开、卡片仍显示未开启（截图反馈 #1）。
   */
  enabled?: boolean
}>()

const emit = defineEmits<{
  (e: "cite", ref: string): void
  (e: "followup", question: string): void
  /** 卡片内的主开关（开启仍需父组件走二次确认） */
  (e: "update:enabled", v: boolean): void
}>()

const question = ref("")

/** 开关是否已开（单一数据源，来自父组件） */
const active = computed(() => props.enabled === true)

const statusLabel = computed(() => {
  switch (props.status) {
    case "streaming":
      return "生成中"
    case "done":
      return "已生成"
    case "unavailable":
      return "不可用"
    case "idle":
      // 关键修复：开关开着就必须显示「已开启」，不能一边开一边显示未开启
      return active.value ? "已开启" : "未开启"
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
    case "idle":
      return active.value ? "bg-primary-subtle text-primary" : "bg-canvas-subtle text-ink-muted"
    default:
      return "bg-canvas-subtle text-ink-muted"
  }
})

/** Markdown → 安全 HTML（含 `[来源n]` 按钮）。逐字追加时重算，代价可忽略。 */
const renderedAnswer = computed(() => renderAnswer(props.answer))

// ── 内部独立滚动 ──
// 消息区自己滚（`overflow-y-auto` + CSS `overscroll-behavior: contain`，容器上见模板类名），
// 并且**只在用户贴着底部时才自动跟随**；用户往上翻读历史时绝不把他拽回去。
const scrollEl = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)
/** 距底部小于该值视为「贴着底部」 */
const BOTTOM_EPS = 48

function onAnswerScroll() {
  const el = scrollEl.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_EPS
}

function scrollToBottom(smooth = false) {
  const el = scrollEl.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
}

watch(
  () => props.answer,
  async () => {
    if (!stickToBottom.value) return
    await nextTick()
    scrollToBottom()
  },
)

onMounted(() => {
  if (props.answer) scrollToBottom()
})

/** 引用按钮走**事件委托**（v-html 内容无法绑 Vue 事件），点击回跳命中卡片。 */
function onAnswerClick(ev: MouseEvent) {
  const target = ev.target as HTMLElement | null
  const btn = target?.closest?.("[data-cite]") as HTMLElement | null
  const ref_ = btn?.dataset?.cite
  if (ref_) emit("cite", ref_)
}

function send() {
  const q = question.value.trim()
  if (!q || props.followupBusy) return
  emit("followup", q)
  question.value = ""
}
</script>

<style scoped>
/* Markdown 正文样式。
   注意：tailwind.config 的 content globs 不含 utils/，所以渲染器字符串里**不能**写工具类
   （会被 purge 掉）—— 这里用语义 token 对应的 CSS 变量，浅色/深色自动跟随。 */
/* 滚动条：细、低调、不压字。
   `scrollbar-gutter: stable` 让滚动槽**始终预留**，出现/消失时文字不会左右跳动。 */
.ai-answer {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--border-color-hover) transparent;
}
.ai-answer::-webkit-scrollbar {
  width: 10px;
}
.ai-answer::-webkit-scrollbar-track {
  background: transparent;
}
.ai-answer::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 9999px;
  background: var(--border-color);
  background-clip: content-box;
}
.ai-answer::-webkit-scrollbar-thumb:hover {
  background: var(--border-color-hover);
  background-clip: content-box;
}

.ai-answer :deep(.md > *:first-child) {
  margin-top: 0;
}
.ai-answer :deep(.md > *:last-child) {
  margin-bottom: 0;
}
.ai-answer :deep(.md p) {
  margin: 0.65em 0;
}
.ai-answer :deep(.md h1),
.ai-answer :deep(.md h2),
.ai-answer :deep(.md h3) {
  margin: 0.85em 0 0.4em;
  font-weight: 600;
  line-height: 1.4;
  color: var(--text-title);
}
.ai-answer :deep(.md h1) {
  font-size: 1.05rem;
}
.ai-answer :deep(.md h2) {
  font-size: 0.95rem;
}
.ai-answer :deep(.md h3) {
  font-size: 0.875rem;
}
.ai-answer :deep(.md ul) {
  margin: 0.65em 0;
  padding-left: 1.4em;
  list-style: disc;
}
.ai-answer :deep(.md ol) {
  margin: 0.65em 0;
  padding-left: 1.4em;
  list-style: decimal;
}
.ai-answer :deep(.md li) {
  margin: 0.3em 0;
}
.ai-answer :deep(.md li > p) {
  margin: 0;
}
.ai-answer :deep(.md strong) {
  font-weight: 600;
  color: var(--text-title);
}
.ai-answer :deep(.md em) {
  font-style: italic;
}
.ai-answer :deep(.md blockquote) {
  margin: 0.6em 0;
  padding: 0.35em 0.75em;
  border-left: 3px solid var(--border-color);
  border-radius: 0 0.375rem 0.375rem 0;
  background: var(--bg-subtle);
  color: var(--text-sub);
}
.ai-answer :deep(.md code) {
  padding: 0.1em 0.35em;
  border: 1px solid var(--border-color);
  border-radius: 0.25rem;
  background: var(--bg-subtle);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.ai-answer :deep(.md pre) {
  margin: 0.6em 0;
  padding: 0.6em 0.75em;
  overflow-x: auto;
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  background: var(--bg-subtle);
}
.ai-answer :deep(.md pre code) {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 0.85em;
}
.ai-answer :deep(.md a) {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.ai-answer :deep(.md hr) {
  margin: 0.9em 0;
  border: 0;
  border-top: 1px solid var(--border-color);
}
/* `[来源n]` 引用按钮（由 utils/markdown.ts 生成，事件委托接住） */
.ai-answer :deep(.prism-cite) {
  display: inline-flex;
  align-items: center;
  margin: 0 0.15em;
  padding: 0 0.35em;
  border: 1px solid var(--border-color);
  border-radius: 0.25rem;
  background: var(--bg-subtle);
  color: var(--primary);
  font-size: 11px;
  font-weight: 500;
  vertical-align: baseline;
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.ai-answer :deep(.prism-cite:hover) {
  border-color: var(--primary);
}
</style>
