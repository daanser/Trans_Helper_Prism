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

    <!-- 下层过滤控制：**确定性的两行**（不再依赖 flex 自动换行 —— 那会把标签挤成孤行、
         把控件顶出卡片、并让按钮错位，三次翻车的根因）
         第一行 = 知识库（标签 + 四个按钮，独占整行因此永远不会被挤压）
         第二行 = 参数控件（返回条数 / 精准重排 / AI 伴读，靠右） -->
    <div class="mt-5 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
      <!-- 第一行：知识源筛选（四个按钮与标签**同一行**，且四个按钮本身永不拆行） -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2" role="group" aria-label="知识库范围">
        <span class="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">知识库：</span>

        <div class="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <button
          v-for="c in corporaOptions"
          :key="c.id"
          type="button"
          :title="c.desc"
          :aria-pressed="selectedCorpora.includes(c.id)"
          class="inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium transition-all"
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
      </div>

      <!-- 第二行：**只放检索参数**（返回条数 + 精准重排）。
           「AI 伴读」属于生成类，**整个搜索区都不再出现它的开关或徽章** ——
           唯一主开关在右侧卡片；结果区只以一行文字提示"已生成要点"，不产生"这里也能开"的误解。 -->
      <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
        <!-- 返回条数（plan-topk.md §3.4）：登录 1–50；未登录只允许 1–5，并提示登录后可用 50 -->
        <div class="flex items-center gap-2">
          <label for="prism-topk" class="text-xs font-medium text-slate-500 dark:text-slate-400">返回条数</label>
          <input
            id="prism-topk"
            v-model.number="topK"
            type="number"
            :min="1"
            :max="topKMax"
            step="1"
            inputmode="numeric"
            :aria-describedby="topKHintId"
            class="w-16 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center text-xs tabular-nums text-slate-700 transition-colors focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            @blur="normalizeTopK()"
            @change="onTopKChange()"
          />
          <span class="text-xs text-slate-400 dark:text-slate-500">/ {{ topKMax }}</span>
          <span v-if="!loggedIn" :id="topKHintId" class="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
            登录后可返回最多 {{ TOP_K_MAX }} 条
          </span>
          <span v-else :id="topKHintId" class="sr-only">允许范围 1 到 {{ TOP_K_MAX }} 条</span>
        </div>

        <ToggleMini v-model="useReranker" label="精准重排" hint="已激活 BAAI/bge-reranker-v2-m3 二次重排序" />
      </div>
    </div>

    <!-- 短提示：**只在打开了会额外消耗额度的功能时出现**，且一行说完 ——
         长文案会打断「筛选区 → 大家常搜」的视觉流（截图反馈 #5）。
         命名统一用「精准重排」，不再出现第二名字（截图反馈 #2）。 -->
    <p v-if="costHint" class="mt-2.5 text-[11px] leading-relaxed text-ink-muted">{{ costHint }}</p>

    <!-- 快捷建议插槽 -->
    <slot name="examples" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { DEFAULT_CORPORA_OPTIONS, type CorpusOption, type SearchRequest } from "~/composables/useApi"
import { TOP_K_ANON_MAX, TOP_K_DEFAULT, TOP_K_MAX, TOP_K_MIN, clampTopK } from "~/composables/usePrefs"
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
const props = withDefaults(
  defineProps<{
    loading: boolean
    useLlm: boolean
    cooldownSec?: number
    /** 是否已登录（决定返回条数上限：未登录 5，登录 50）；缺省 false（安全侧） */
    loggedIn?: boolean
  }>(),
  { cooldownSec: 0, loggedIn: false },
)
const emit = defineEmits<{
  (e: "submit", p: Pick<SearchRequest, "query" | "corpora" | "use_reranker" | "use_llm" | "top_k">): void
}>()
const { pushToast } = useToast()
const { prefs, load: loadPrefs, save: savePrefs } = usePrefs()

const query = ref("")
const searchInput = ref<HTMLInputElement | null>(null)
const selectedCorpora = ref<string[]>(["mtf-wiki", "ftm-wiki", "rle-wiki", "miomtfwiki"])
const useReranker = ref(true)

/** 一句短提示：只在开了精准重排时出现；**不重复讲 AI 伴读的额度**（那些细节归右侧卡片） */
const costHint = computed(() =>
  useReranker.value ? "精准重排会优先展示更相关的结果，可能额外消耗额度。" : "",
)
const corporaOptions: CorpusOption[] = DEFAULT_CORPORA_OPTIONS

/**
 * 返回条数：未登录上限 5（与后端夹取一致），登录 1–50。
 * 初始值取匿名上限（预渲染/SSR 阶段无会话 → 渲染出 "5 / 5" 这种自洽状态），
 * 挂载后再按"登录态 + 本地偏好"校正（登录用户恢复自己存的值）。
 */
const topK = ref<number>(Math.min(TOP_K_ANON_MAX, TOP_K_DEFAULT))
/**
 * **用户偏好值**（设置/本地存储里的那条），与"当前上限内的显示值"分开存。
 * 为什么必须分开：`onMounted` 时登录态往往还没加载（`topKMax=5`），若直接
 * `topK = min(topKMax, 偏好)` 就会被压到 5，而登录态变化时只做"夹取"不会升回来 ——
 * 结果登录用户永远停在 5 条（实测反馈 #4）。
 */
const preferredTopK = ref<number>(TOP_K_DEFAULT)
const topKMax = computed(() => (props.loggedIn ? TOP_K_MAX : TOP_K_ANON_MAX))
const topKHintId = "prism-topk-hint"

/** 按当前上限把偏好值投射到显示值（登录 → 恢复偏好；登出 → 夹到 5） */
function syncTopKFromPreferred() {
  topK.value = Math.min(topKMax.value, Math.max(TOP_K_MIN, Math.round(preferredTopK.value)))
}

/** 输入框失焦/回车后归一：夹到 [1, topKMax] 的整数（手输 999 不会静默发出去） */
/** 只夹取、**不写偏好**（登录态变化/失焦/提交前调用：这些都不是"用户表达偏好"） */
function normalizeTopK() {
  topK.value = Math.min(topKMax.value, Math.max(TOP_K_MIN, Math.round(Number(topK.value) || TOP_K_DEFAULT)))
}

/**
 * 用户主动改过输入框（`change` 事件）→ 归一 + 持久化进 usePrefs（与 corpora/rerank/llm 一致）。
 * 只在用户改动时写盘，避免把"未登录被夹到 5"当成用户偏好存下来（那会让登录后仍停在 5）。
 */
function onTopKChange() {
  normalizeTopK()
  preferredTopK.value = topK.value
  if (prefs.value.topK !== topK.value) savePrefs({ topK: topK.value })
}

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



function clear() {
  query.value = ""
  nextTick(() => searchInput.value?.focus())
}

function submit() {
  const q = query.value.trim()
  if (!q || props.loading || cooling.value) return
  normalizeTopK() // 提交前再夹一次：键盘回车等入口不会绕过上限
  emit("submit", {
    query: q,
    corpora: [...selectedCorpora.value],
    use_reranker: useReranker.value,
    use_llm: props.useLlm,
    top_k: topK.value,
  })
}

onMounted(() => {
  // 客户端载入 /settings 保存的默认偏好（预渲染首屏保持默认值，避免 hydration 不一致）
  const saved = loadPrefs()
  selectedCorpora.value = [...saved.corpora]
  useReranker.value = saved.reranker
  preferredTopK.value = clampTopK(saved.topK)
  syncTopKFromPreferred()
})

// 登录态变化（登录/登出）后重新夹取：未登录时必须回到 ≤5，避免把 50 发出去被后端夹
watch(
  () => props.loggedIn,
  () => syncTopKFromPreferred(),
)

defineExpose({
  focus: () => searchInput.value?.focus(),
  setQuery: (v: string) => {
    query.value = v
  },
  submit,
})
</script>
