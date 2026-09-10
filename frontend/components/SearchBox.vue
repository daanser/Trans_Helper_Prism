<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 搜索指令台（SearchBox）
     - 人文温润、清晰聚焦的搜索交互台
     - 四个知识库去除沉重纯黑死寂色，采用轻盈浅透的品牌微色与发丝勾选标
     - 开关控件与输入状态清晰可见 -->
<template>
  <section class="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900 sm:p-7">
    <!-- 检索主输入区域 -->
    <div class="flex flex-col gap-3 sm:flex-row">
      <div class="relative flex-1">
        <!-- 搜索放大镜图标 -->
        <div class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>

        <input
          ref="searchInput"
          v-model="query"
          type="text"
          :disabled="loading"
          enterkeyhint="search"
          placeholder="搜索药物剂量、证件变更流程、嗓音训练、心理评估等…"
          class="w-full rounded-xl border border-slate-200 bg-slate-50/70 py-3.5 pl-11 pr-10 text-sm text-slate-900 placeholder:text-slate-400 transition-all focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-500/15 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:focus:border-blue-500"
          @keydown.enter="submit"
        />

        <!-- 清空按钮 -->
        <button
          v-if="query"
          type="button"
          aria-label="清空输入"
          class="absolute right-3.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
          @mousedown.prevent="clear()"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <!-- 搜索操作按钮：视觉焦点，群青蓝 -->
      <button
        type="button"
        :disabled="loading || cooling || !query.trim()"
        class="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 px-7 py-3.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-blue-700 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 dark:bg-blue-500 dark:hover:bg-blue-600"
        @click="submit"
      >
        <svg v-if="loading" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        <span>{{ loading ? "检索中…" : cooling ? `${cooldownSec} 秒后可重试` : "搜索文献" }}</span>
      </button>
    </div>

    <!-- 下层过滤控制：轻盈微质感知识库选择 + 开关选项 -->
    <div class="mt-5 flex flex-col gap-4 border-t border-slate-100 pt-4 dark:border-slate-800 md:flex-row md:items-center md:justify-between">
      <!-- 知识源筛选：去除死寂纯黑，改为轻盈透气的微质感选中态 -->
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="知识库范围">
        <span class="text-xs font-medium text-slate-500 dark:text-slate-400">知识库：</span>

        <button
          v-for="c in corporaOptions"
          :key="c.id"
          type="button"
          :title="c.desc"
          :aria-pressed="selectedCorpora.includes(c.id)"
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all"
          :class="
            selectedCorpora.includes(c.id)
              ? 'border-blue-500/40 bg-blue-50/80 text-blue-700 shadow-sm dark:border-blue-400/30 dark:bg-blue-950/40 dark:text-blue-300'
              : 'border-slate-200 bg-slate-50 text-slate-400 hover:border-slate-300 hover:text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:border-slate-600'
          "
          @click="toggleCorpus(c.id)"
        >
          <svg
            v-if="selectedCorpora.includes(c.id)"
            class="h-3.5 w-3.5 text-blue-600 dark:text-blue-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>{{ c.name }}</span>
        </button>
      </div>

      <!-- 参数开关（精准重排 & AI伴读） -->
      <div class="flex shrink-0 items-center gap-6">
        <ToggleMini v-model="useReranker" label="精准重排" hint="已激活 BAAI/bge-reranker-v2-m3 二次重排序" />
        <ToggleMini
          :model-value="useLlm"
          label="AI 伴读"
          @update:model-value="onLlmToggle"
        />
      </div>
    </div>

    <!-- 快捷建议插槽 -->
    <slot name="examples" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue"
import { DEFAULT_CORPORA_OPTIONS, type CorpusOption, type SearchRequest } from "~/composables/useApi"
import { useToast } from "~/composables/useToast"
import ToggleMini from "./ToggleMini.vue"

/**
 * `useLlm` 由父组件受控：开关只是「请求开启」，真正的开启要等父组件完成二次确认弹窗，
 * 避免用户误触后直接产生配额消耗（tasks.md T3.6）。
 *
 * `cooldownSec`（可选，缺省 0 = 行为与以前完全一致）：被后端分档限流（429）后的冷却剩余秒数。
 * > 0 时禁用提交按钮并把按钮文案换成「N 秒后可重试」——输入框**保持可编辑**，
 * 用户仍可改词/换库，只是不能提交（提交的硬拦截在 pages/index.vue 的 doSearch 里还有一道）。
 */
const props = withDefaults(defineProps<{ loading: boolean; useLlm: boolean; cooldownSec?: number }>(), {
  cooldownSec: 0,
})
const emit = defineEmits<{
  (e: "submit", p: Pick<SearchRequest, "query" | "corpora" | "use_reranker" | "use_llm" | "top_k">): void
  (e: "update:useLlm", v: boolean): void
}>()
const { pushToast } = useToast()
const { prefs, load: loadPrefs } = usePrefs()

const query = ref("")
const searchInput = ref<HTMLInputElement | null>(null)
const selectedCorpora = ref<string[]>(["mtf-wiki", "ftm-wiki", "rle-wiki", "miomtfwiki"])
const useReranker = ref(true)
const corporaOptions: CorpusOption[] = DEFAULT_CORPORA_OPTIONS

/** 限流冷却中（父组件传下来的剩余秒数 > 0） */
const cooling = computed(() => (props.cooldownSec ?? 0) > 0)

function toggleCorpus(id: string) {
  if (selectedCorpora.value.includes(id)) {
    if (selectedCorpora.value.length > 1) {
      selectedCorpora.value = selectedCorpora.value.filter((c) => c !== id)
    } else {
      pushToast("请至少保留一个知识库", "warning")
    }
  } else {
    selectedCorpora.value = [...selectedCorpora.value, id]
  }
}

function onLlmToggle(next: boolean) {
  emit("update:useLlm", next)
}

function clear() {
  query.value = ""
  nextTick(() => searchInput.value?.focus())
}

function submit() {
  const q = query.value.trim()
  if (!q || props.loading || cooling.value) return
  emit("submit", {
    query: q,
    corpora: [...selectedCorpora.value],
    use_reranker: useReranker.value,
    use_llm: props.useLlm,
    top_k: 10,
  })
}

onMounted(() => {
  // 客户端载入 /settings 保存的默认偏好（预渲染首屏保持默认值，避免 hydration 不一致）
  const saved = loadPrefs()
  selectedCorpora.value = [...saved.corpora]
  useReranker.value = saved.reranker
})

defineExpose({
  focus: () => searchInput.value?.focus(),
  setQuery: (v: string) => {
    query.value = v
  },
  submit,
})
</script>
