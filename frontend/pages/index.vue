<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 检索主页（/）
     - 人文与专业并重的高清晰知识检索平台
     - 纯正自然的中文界面，层次分明的卡片与视觉焦点
     - 优雅温润的低饱和色彩辅助，杜绝泛滥的 AI 营销感 -->
<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
    <div class="lg:flex lg:gap-10">
      <!-- 主检索与结果信息流 -->
      <div class="min-w-0 flex-1">
        <!-- 页面主标题区域（未检索时展示） -->
        <header v-if="!hasSearched" class="mb-8">
          <div class="mb-2 inline-flex items-center gap-1.5 rounded-full bg-primary-subtle px-3 py-1 text-xs font-medium text-primary">
            <span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
            <span>社群医疗与生活文献检索平台</span>
          </div>
          <h1 class="text-3xl font-extrabold tracking-tight text-ink-title sm:text-4xl lg:text-5xl">
            四本社群编写的指南，<br class="hidden sm:inline" />
            聚合于一个搜索框。
          </h1>
          <p class="mt-3.5 max-w-2xl text-sm leading-relaxed text-ink-sub sm:text-base">
            涵盖 MtF Wiki、FtM Wiki、RLE Wiki 与 Mio MtF 四部中文知识库。通过语义向量检索与精确二次重排，直达社群经验与专业指引原文。
          </p>
        </header>

        <!-- 核心搜索卡片 -->
        <SearchBox ref="searchBoxRef" :loading="loading" @submit="doSearch">
          <!-- 快捷检索建议词 -->
          <template v-if="!hasSearched" #examples>
            <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-surface-border pt-4">
              <span class="text-xs text-ink-muted">大家常搜：</span>
              <button
                v-for="ex in quickExamples"
                :key="ex"
                type="button"
                class="rounded-lg border border-surface-border bg-canvas-subtle px-3 py-1.5 text-xs text-ink-body transition-all hover:border-primary hover:bg-surface hover:text-primary"
                @click="onQuickSearch(ex)"
              >
                {{ ex }}
              </button>
            </div>
          </template>
        </SearchBox>

        <!-- 移动端 AI 伴读卡位 -->
        <div v-if="hasSearched" class="mt-6 lg:hidden">
          <AiCompanionCard :streaming="loading" @cite="scrollToHit" />
        </div>

        <!-- 检索骨架屏 -->
        <div v-if="loading" class="mt-6 space-y-4">
          <div v-for="i in 3" :key="i" class="animate-pulse rounded-xl border border-surface-border bg-surface p-6 shadow-card">
            <div class="mb-3 flex items-center justify-between">
              <div class="h-5 w-24 rounded-md bg-canvas-subtle"></div>
              <div class="h-4 w-16 rounded bg-canvas-subtle"></div>
            </div>
            <div class="mb-3 h-5 w-3/4 rounded bg-canvas-subtle"></div>
            <div class="space-y-2">
              <div class="h-4 w-full rounded bg-canvas-subtle"></div>
              <div class="h-4 w-5/6 rounded bg-canvas-subtle"></div>
              <div class="h-4 w-2/3 rounded bg-canvas-subtle"></div>
            </div>
          </div>
        </div>

        <!-- 异常报错 -->
        <div v-else-if="error" class="mt-6 rounded-xl border border-danger/30 bg-danger-subtle p-5">
          <div class="flex items-start gap-3">
            <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger text-white text-xs font-bold">
              !
            </div>
            <div class="min-w-0 flex-1">
              <h4 class="text-sm font-semibold text-danger">检索遇到问题</h4>
              <p class="mt-1 break-words text-xs leading-relaxed text-ink-body">{{ error }}</p>
              <p class="mt-2 text-xs text-ink-muted">请检查网络或稍后重试，适当减少勾选的知识库也有助于定位问题。</p>
            </div>
          </div>
        </div>

        <!-- 空态与引导 -->
        <template v-else>
          <!-- 初始未搜索引导 -->
          <div v-if="!hasSearched" class="mt-8 rounded-2xl border border-dashed border-surface-border p-8 text-center sm:p-12">
            <div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </div>
            <p class="text-sm font-semibold text-ink-title">在上方输入关键词开启检索</p>
            <p class="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-sub">
              支持激素方案、证件姓名变更、心理诊断、嗓音训练及社群真实生活经验。检索结果直溯官方文档原文。
            </p>
          </div>

          <!-- 无匹配结果 -->
          <div v-else-if="results.length === 0" class="mt-8 rounded-2xl border border-dashed border-surface-border p-8 text-center sm:p-12">
            <p class="text-sm font-semibold text-ink-title">未发现匹配的条目</p>
            <p class="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-sub">
              建议缩短搜索词、尝试医学通用词或别名，或勾选全部知识库再次搜索。
            </p>
            <button
              type="button"
              class="mt-4 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
              @click="searchBoxRef?.focus()"
            >
              重新编辑搜索词
            </button>
          </div>
        </template>

        <!-- 结果列表展示 -->
        <template v-if="!loading && !error && results.length > 0">
          <!-- 降级提示 -->
          <div v-if="fallback" class="mt-6 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/30">
            <span class="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-200">
              降级模式
            </span>
            <span class="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              因上游向量服务波动，当前已自动切换为基础分词索引模式。
            </span>
          </div>

          <!-- 配额预警 -->
          <div v-if="quotaWarning" class="mt-4 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-subtle p-3.5">
            <span class="rounded bg-danger/20 px-1.5 py-0.5 text-xs font-medium text-danger">
              额度提示
            </span>
            <span class="text-xs leading-relaxed text-ink-body">
              当前账户剩余额度已低于 10%，请注意规划查询频次。
            </span>
          </div>

          <!-- 检索指标与命中数量 -->
          <div class="mb-4 mt-6 flex flex-col gap-2 border-b border-surface-border pb-3 sm:flex-row sm:items-center sm:justify-between">
            <TimingsBar :timings="resultsTimings" />
            <span class="text-xs text-ink-muted">
              共命中 <b class="font-medium text-ink-title">{{ results.length }}</b> 条文献
            </span>
          </div>

          <!-- 结果卡片信息流 -->
          <div class="space-y-4">
            <HitCard
              v-for="h in results"
              :key="h.id"
              :hit="h"
              :query="lastQuery"
              :highlight="highlightedHitId === h.id"
            />
          </div>
        </template>
      </div>

      <!-- 桌面右侧：AI 伴读与引用视窗 -->
      <aside class="hidden w-80 shrink-0 lg:block">
        <AiCompanionCard :streaming="loading" @cite="scrollToHit" />
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue"
import { useApi, type SearchResponse, type SearchRequest, type SearchTimings } from "~/composables/useApi"
import { useToast } from "~/composables/useToast"
import SearchBox from "~/components/SearchBox.vue"
import HitCard from "~/components/HitCard.vue"
import TimingsBar from "~/components/TimingsBar.vue"
import AiCompanionCard from "~/components/AiCompanionCard.vue"

const { search } = useApi()
const { pushToast } = useToast()

const searchBoxRef = ref<InstanceType<typeof SearchBox> | null>(null)
const loading = ref(false)
const hasSearched = ref(false)
const lastQuery = ref("")
const error = ref("")
const results = ref<SearchResponse["hits"]>([])
const responseTimings = ref<SearchTimings | null>(null)
const fallback = ref(false)
const quota = ref<SearchResponse["quota"] | null>(null)
const warnings = ref<string[]>([])
const highlightedHitId = ref<string | null>(null)

const quickExamples = [
  "HRT 激素替代治疗常用方案有哪些？",
  "跨性别证件姓名与性别变更指引",
  "MtF 嗓音女性化训练基础",
  "性别重置手术心理评估流程",
]

const resultsTimings = computed<SearchTimings>(() => responseTimings.value ?? {
  embed_ms: 0,
  search_ms: 0,
  rerank_ms: 0,
  llm_ms: 0,
  total_ms: 0,
})

const quotaWarning = computed(() => {
  if (!quota.value || quota.value.remaining_h == null) return false
  return quota.value.remaining_h < 0.5
})

function onQuickSearch(queryText: string) {
  if (searchBoxRef.value) {
    searchBoxRef.value.setQuery(queryText)
    searchBoxRef.value.submit()
  }
}

function scrollToHit(citationId: string) {
  highlightedHitId.value = citationId
  const el = document.getElementById(`hit-${citationId}`)
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" })
  }
}

async function doSearch(payload: Pick<SearchRequest, "query" | "corpora" | "use_reranker" | "use_llm" | "top_k">) {
  loading.value = true
  error.value = ""
  hasSearched.value = true
  lastQuery.value = payload.query
  highlightedHitId.value = null

  try {
    const res = await search(payload)
    results.value = res.hits || []
    responseTimings.value = res.timings
    fallback.value = !!res.fallback
    quota.value = res.quota
    warnings.value = res.warnings || []

    if (res.warnings?.length) {
      for (const w of res.warnings) {
        if (w.includes("fallback")) {
          pushToast("已自动切换至降级检索模式", "warning")
        }
      }
    }
  } catch (err: any) {
    error.value = err?.message || "网络请求异常，请稍后重试"
    results.value = []
    pushToast(error.value, "error")
  } finally {
    loading.value = false
  }
}
</script>
