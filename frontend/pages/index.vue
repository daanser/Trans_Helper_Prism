<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 检索主页（/）
     - 人文与专业并重的高清晰知识检索平台
     - 纯正自然的中文界面，层次分明的卡片与视觉焦点
     - 优雅温润的低饱和色彩辅助，杜绝泛滥的 AI 营销感
     - T3.6：AI 伴读二次确认 + SSE 流式渲染 + [来源n] 引用回跳（后端未实现时降级，不影响主检索） -->
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
        <SearchBox
          ref="searchBoxRef"
          :loading="loading"
          :use-llm="llmEnabled"
          @submit="doSearch"
          @update:use-llm="onLlmToggle"
        >
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
          <AiCompanionCard
            :answer="aiAnswer"
            :citations="aiCitations"
            :model="aiModel"
            :streaming="loading || aiStreaming"
            :status="aiStatus"
            :notice="aiNotice"
            :followup-busy="aiStreaming"
            :followup-enabled="llmEnabled && results.length > 0"
            @cite="onCite"
            @followup="onFollowUp"
          />
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

          <!-- 配额预警（百分比口径；回退检索不消耗额度） -->
          <div v-if="quotaExceeded || quotaWarning" class="mt-4 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-subtle p-3.5">
            <span class="rounded bg-danger/20 px-1.5 py-0.5 text-xs font-medium text-danger">
              额度提示
            </span>
            <span class="text-xs leading-relaxed text-ink-body">
              <template v-if="quotaExceeded">
                本窗口额度已用尽<template v-if="quotaResetHours">，约 {{ quotaResetHours }} 小时后恢复</template>。当前检索已切换为回退模式（回退不消耗额度）。
              </template>
              <template v-else>
                本窗口剩余额度已低于 10%，请注意规划查询频次；超出后将自动切换为回退检索。
              </template>
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
        <AiCompanionCard
          :answer="aiAnswer"
          :citations="aiCitations"
          :model="aiModel"
          :streaming="loading || aiStreaming"
          :status="aiStatus"
          :notice="aiNotice"
          :followup-busy="aiStreaming"
          :followup-enabled="llmEnabled && results.length > 0"
          @cite="onCite"
          @followup="onFollowUp"
        />
      </aside>
    </div>

    <!-- AI 伴读二次确认（说明配额消耗，可取消） -->
    <ConfirmDialog
      :open="showLlmConfirm"
      title="开启 AI 伴读？"
      confirm-text="开启并消耗配额"
      cancel-text="暂不开启"
      @confirm="confirmLlm"
      @cancel="cancelLlm"
    >
      <p>
        AI 伴读会调用大模型，基于本次检索命中的文献生成要点总结，并支持继续追问。
      </p>
      <ul class="mt-2.5 space-y-1.5 text-xs">
        <li>· 每次总结与每轮追问都会消耗账户额度（滚动窗口固定额度，顶栏实时显示剩余百分比）。</li>
        <li>· 内容仅依据检索到的原文片段生成，并标注 <span class="font-medium text-ink-title">[来源n]</span> 引用，请以原文为准。</li>
        <li>· 关闭开关即可随时停止；主检索结果不受影响。</li>
      </ul>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useApi, isUnimplemented, type SearchHit, type SearchResponse, type SearchRequest, type SearchTimings } from "~/composables/useApi"
import { useToast } from "~/composables/useToast"
import SearchBox from "~/components/SearchBox.vue"
import HitCard from "~/components/HitCard.vue"
import TimingsBar from "~/components/TimingsBar.vue"
import AiCompanionCard from "~/components/AiCompanionCard.vue"
import ConfirmDialog from "~/components/ConfirmDialog.vue"

type AiStatus = "idle" | "streaming" | "done" | "unavailable"

const { search, searchStream, chat } = useApi()
const { pushToast } = useToast()
const { prefs, load: loadPrefs, save: savePrefs } = usePrefs()
const { isLoggedIn, loadMe } = useAuth()

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

// ── AI 伴读（T3.4 / T3.6）──
const llmEnabled = ref(false)
const showLlmConfirm = ref(false)
const aiStatus = ref<AiStatus>("idle")
const aiAnswer = ref("")
const aiModel = ref("")
const aiNotice = ref("")
const aiCitations = ref<string[]>([])
/** 流式接口若自带 hits，用它做引用映射；否则回落到本次主检索结果 */
const streamHits = ref<SearchHit[]>([])
const sessionId = ref("")
const lastRequest = ref<SearchRequest | null>(null)
let aiAbort: AbortController | null = null

const aiStreaming = computed(() => aiStatus.value === "streaming")

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

/** 配额提示（T3.2 新契约：只按百分比判断；字段缺失时不提示、不阻断） */
const quotaExceeded = computed(() => quota.value?.exceeded === true)

const quotaRemainingPct = computed<number | null>(() => {
  const q = quota.value
  if (!q) return null
  if (typeof q.remaining_pct === "number" && Number.isFinite(q.remaining_pct)) return q.remaining_pct
  if (typeof q.used_pct === "number" && Number.isFinite(q.used_pct)) return 100 - q.used_pct
  return null
})

const quotaWarning = computed(() => {
  if (quotaExceeded.value) return false
  const pct = quotaRemainingPct.value
  return pct !== null && pct < 10
})

const quotaResetHours = computed<number | null>(() => {
  const q = quota.value
  if (!q || typeof q.window_start !== "number" || typeof q.window_hours !== "number") return null
  return Math.max(1, Math.ceil((q.window_start + q.window_hours * 3600e3 - Date.now()) / 3600e3))
})

function onQuickSearch(queryText: string) {
  if (searchBoxRef.value) {
    searchBoxRef.value.setQuery(queryText)
    searchBoxRef.value.submit()
  }
}

/** [来源n] → 第 n 条命中；找不到时提示而不是静默 */
function resolveCitation(ref: string): SearchHit | null {
  const n = Number.parseInt(String(ref).replace(/\D/g, ""), 10)
  if (!Number.isFinite(n) || n < 1) return null
  const pool = streamHits.value.length ? streamHits.value : results.value
  return pool[n - 1] ?? null
}

function scrollToHit(citationRef: string) {
  const hit = resolveCitation(citationRef)
  if (!hit) {
    pushToast("该引用不在本次检索结果中", "warning")
    return
  }
  highlightedHitId.value = hit.id
  const el = document.getElementById(`hit-${hit.id}`)
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" })
}

function onCite(ref: string) {
  scrollToHit(ref)
}

/** AI 伴读开关：开启必须先过二次确认（说明配额消耗） */
function onLlmToggle(next: boolean) {
  if (!next) {
    llmEnabled.value = false
    savePrefs({ llm: false })
    cancelAiStream()
    aiStatus.value = "idle"
    aiNotice.value = ""
    return
  }
  showLlmConfirm.value = true
}

function confirmLlm() {
  showLlmConfirm.value = false
  llmEnabled.value = true
  savePrefs({ llm: true })
  pushToast("已开启 AI 伴读，总结与追问将消耗配额", "info")
  // 已有结果时立刻为上一次查询生成总结
  if (hasSearched.value && lastRequest.value && results.value.length > 0) {
    void runAi(lastRequest.value)
  }
}

function cancelLlm() {
  showLlmConfirm.value = false
  pushToast("已取消，AI 伴读保持关闭", "info")
}

function cancelAiStream() {
  if (aiAbort) {
    aiAbort.abort()
    aiAbort = null
  }
}

/** 统一的 SSE 消费：流式追加正文，404/501 降级为「AI 总结暂不可用」 */
async function runAi(req: SearchRequest) {
  cancelAiStream()
  const controller = new AbortController()
  aiAbort = controller
  aiStatus.value = "streaming"
  aiNotice.value = ""
  aiAnswer.value = ""
  aiCitations.value = []
  streamHits.value = []
  aiModel.value = ""
  sessionId.value = ""

  const payload: SearchRequest = {
    ...req,
    use_llm: true,
    llm_mode: "summary",
    session_id: undefined,
  }

  let received = ""
  try {
    await searchStream(
      payload,
      {
        onDelta: (delta) => {
          received += delta
          aiAnswer.value += delta
        },
        onHits: (hits) => {
          if (hits.length) streamHits.value = hits
        },
        onCitations: (citations) => {
          aiCitations.value = citations
        },
        onMeta: (meta) => {
          if (meta.model) aiModel.value = meta.model
        },
        onSession: (id) => {
          sessionId.value = id
        },
        onNotice: (notice) => {
          aiNotice.value = notice
        },
      },
      controller.signal,
    )
    if (received.trim()) {
      aiStatus.value = "done"
    } else {
      aiStatus.value = "unavailable"
      aiNotice.value = "AI 总结暂不可用：服务未返回内容。主检索结果不受影响。"
    }
  } catch (err: unknown) {
    if ((err as Error)?.name === "AbortError") return
    if (received.trim()) {
      // 已经流出了一部分：保留内容，只提示中断
      aiStatus.value = "done"
      aiNotice.value = "AI 总结中断，以上为已生成的部分内容。"
    } else {
      aiStatus.value = "unavailable"
      aiNotice.value = aiFailureText(err)
    }
  } finally {
    if (aiAbort === controller) aiAbort = null
    // 每轮都扣额度，结束后刷新顶栏剩余百分比（GET /api/v1/me）
    if (isLoggedIn.value) void loadMe()
  }
}

/** 把各类失败翻译成用户能懂的话（不暴露内部细节） */
function aiFailureText(err: unknown): string {
  const status = (err as { status?: number })?.status
  const code = (err as { code?: string })?.code ?? ""
  if (isUnimplemented(err)) return "AI 总结暂不可用：后端流式接口尚未实现。主检索结果不受影响。"
  if (status === 401) return "AI 总结需要登录后使用，请先登录。主检索结果不受影响。"
  if (status === 429 || code === "quota-exceeded") return "本窗口额度已用尽，AI 总结暂不可用；回退检索不消耗额度。"
  if (code === "llm-unavailable" || code === "llm-upstream" || code === "llm-not-configured") {
    return "AI 总结暂不可用（上游模型不可用）。主检索结果不受影响。"
  }
  if (code) return `AI 总结暂不可用：${code}。主检索结果不受影响。`
  return `AI 总结暂不可用：${(err as Error)?.message || "服务异常"}。主检索结果不受影响。`
}

/** 多轮追问走 POST /api/v1/chat（非流式），追加到同一会话正文之后 */
async function onFollowUp(question: string) {
  if (!lastRequest.value) return
  if (!llmEnabled.value) {
    pushToast("请先开启 AI 伴读", "warning")
    return
  }
  if (!sessionId.value) {
    // 还没有会话（例如总结失败）→ 用首轮查询重新开一个流式会话
    void runAi(lastRequest.value)
    pushToast("正在重建会话，请稍后再追问", "info")
    return
  }
  aiStatus.value = "streaming"
  aiNotice.value = ""
  aiAnswer.value = `${aiAnswer.value}\n\n——\n\n`
  try {
    const res = await chat(sessionId.value, question)
    const text = (res.text ?? "").trim()
    aiAnswer.value += text || "（未返回内容）"
    if (res.citations?.length) aiCitations.value = [...aiCitations.value, ...res.citations]
    if (res.model) aiModel.value = res.model
    aiStatus.value = "done"
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status
    const code = (err as { code?: string })?.code ?? ""
    aiStatus.value = "unavailable"
    if (status === 409 || code === "max-rounds") {
      aiNotice.value = "本会话已达 10 轮上限，请重新检索开启新会话。"
    } else {
      aiNotice.value = aiFailureText(err)
    }
  } finally {
    if (isLoggedIn.value) void loadMe()
  }
}

async function doSearch(payload: Pick<SearchRequest, "query" | "corpora" | "use_reranker" | "use_llm" | "top_k">) {
  loading.value = true
  error.value = ""
  hasSearched.value = true
  lastQuery.value = payload.query
  highlightedHitId.value = null
  cancelAiStream()
  aiStatus.value = "idle"
  aiNotice.value = ""
  aiAnswer.value = ""
  aiCitations.value = []
  streamHits.value = []

  const req: SearchRequest = { ...payload, use_llm: false }
  lastRequest.value = req

  try {
    // 主检索永远不依赖 LLM：use_llm 恒为 false，AI 走独立 SSE 通道
    const res = await search(req)
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

    if (isLoggedIn.value) void loadMe()
  } catch (err: any) {
    error.value = err?.message || "网络请求异常，请稍后重试"
    results.value = []
    pushToast(error.value, "error")
  } finally {
    loading.value = false
  }

  // 主检索完成后（成功或失败）再单独触发 AI；失败只影响 AI 卡片，不回滚结果
  if (llmEnabled.value && !error.value && results.value.length > 0) {
    void runAi(req)
  }
}

onMounted(() => {
  const saved = loadPrefs()
  llmEnabled.value = saved.llm
})

onBeforeUnmount(() => {
  cancelAiStream()
})

// 偏好变更后同步（设置页可能在同一 SPA 会话里改过）
watch(prefs, (next) => {
  llmEnabled.value = next.llm
})
</script>
