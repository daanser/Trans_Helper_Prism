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
          :logged-in="isLoggedIn"
          :cooldown-sec="cooldownRemaining"
          @submit="doSearch"
        >
        </SearchBox>


        <!-- 429 分档限流提示（**不清空已有结果**；有 retry_after 时做倒计时并禁用提交） -->
        <div
          v-if="rateLimit"
          role="status"
          class="mt-6 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/30"
        >
          <span class="shrink-0 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-200">
            请求过于频繁
          </span>
          <div class="min-w-0 flex-1 space-y-1">
            <p class="text-xs leading-relaxed text-amber-800 dark:text-amber-200">{{ rateLimitMessage }}</p>
            <p v-if="showLoginHint" class="text-xs leading-relaxed text-amber-800/90 dark:text-amber-200/90">
              登录后额度更高（{{ LOGGED_IN_LIMIT_PER_MIN }} 次/分钟），日常使用基本不会碰到这个提示。
              <NuxtLink to="/login" class="font-medium underline underline-offset-2">去登录</NuxtLink>
            </p>
            <p v-else-if="results.length > 0" class="text-xs leading-relaxed text-amber-800/80 dark:text-amber-200/80">
              下方仍保留上一次的检索结果，可继续查阅。
            </p>
          </div>
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
          <!-- 未搜索（首屏）：紧贴搜索卡下方作为空状态引导（用户反馈 #2：不要贴近页脚）。
               也不再有大方框/虚线占位。
               这里同时承担「大家常搜」的落点 —— 它已从表单卡里搬出来（反馈 #3），
               作为搜索前的推荐，而不是和「知识库 / 返回条数」挤在同一张表单里。 -->
          <div v-if="!hasSearched" class="mt-5">
            <p class="text-center text-xs text-ink-muted">试试这些：</p>
            <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button
                v-for="ex in quickExamples"
                :key="ex"
                type="button"
                class="rounded-full border border-surface-border bg-surface px-3.5 py-1.5 text-xs text-ink-body shadow-card transition-all hover:border-primary hover:text-primary"
                @click="onQuickSearch(ex)"
              >
                {{ ex }}
              </button>
            </div>
          </div>

          <!-- 无匹配结果（限流时改由上方提示卡说明，不在这里误报「未发现」） -->
          <div v-else-if="results.length === 0 && !rateLimit" class="mt-8 rounded-2xl border border-dashed border-surface-border p-8 text-center sm:p-12">
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
              <template v-if="loginRequired">
                当前按关键词回退检索（服务端开启了强制登录时会这样）。
                <NuxtLink to="/login" class="font-medium underline underline-offset-2">登录</NuxtLink>
                后即可用完整向量检索、AI 伴读与多轮追问。
              </template>
              <template v-else>
                因上游向量服务波动，当前已自动切换为基础分词索引模式。
              </template>
            </span>
          </div>

          <!-- 配额预警（百分比口径；回退检索不消耗额度） -->
          <div v-if="quotaExceeded || quotaWarning" class="mt-4 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger-subtle p-3.5">
            <span class="rounded bg-danger/20 px-1.5 py-0.5 text-xs font-medium text-danger">
              额度提示
            </span>
            <span class="text-xs leading-relaxed text-ink-body">
              <template v-if="quotaExceeded">
                本窗口额度已用尽<template v-if="quotaResetAtLabel && quotaResetHours">，将于 {{ quotaResetAtLabel }}（约 {{ quotaResetHours }} 小时后）恢复</template><template v-else-if="quotaResetHours">，约 {{ quotaResetHours }} 小时后恢复</template>。当前检索已切换为回退模式（回退不消耗额度）。
              </template>
              <template v-else>
                本窗口剩余额度已低于 10%，请注意规划查询频次；超出后将自动切换为回退检索。
              </template>
            </span>
          </div>

          <!-- 未登录被夹取返回条数（plan-topk.md §3.1）：**非错误**提示，info 级 -->
          <div
            v-if="topKClamped"
            class="mt-4 flex items-start gap-2.5 rounded-xl border border-surface-border bg-canvas-subtle p-3.5"
          >
            <span class="rounded bg-primary-subtle px-1.5 py-0.5 text-xs font-medium text-primary">
              提示
            </span>
            <span class="text-xs leading-relaxed text-ink-sub">
              未登录时最多返回 {{ TOP_K_ANON_MAX }} 条；
              <NuxtLink to="/login" class="font-medium underline underline-offset-2">登录</NuxtLink>
              后可选择最多 {{ TOP_K_MAX }} 条。
            </span>
          </div>

          <!-- 检索指标与命中数量 -->
          <div class="mb-4 mt-6 flex flex-col gap-2 border-b border-surface-border pb-3 sm:flex-row sm:items-center sm:justify-between">
            <TimingsBar :timings="resultsTimings" />
            <span class="text-xs text-ink-muted">
              共返回 <b class="font-medium text-ink-title">{{ results.length }}</b> 条文献
              <!-- AI 伴读的成果**只在结果区留一行纯文字**：不产生"这里也能开关"的误解 -->
              <template v-if="aiStatus === 'done'">
                <span aria-hidden="true"> · </span><span class="text-primary">已生成要点</span>
              </template>
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

      <!-- 桌面（≥lg）右侧栏：「本次检索要点」；<lg 时整栏隐藏，改由底部抽屉承载（见文件末尾） -->
      <aside class="hidden w-80 shrink-0 lg:block xl:w-96">
        <AiCompanionCard
          :answer="aiAnswer"
          :citations="aiCitations"
          :model="aiModel"
          :streaming="loading || aiStreaming"
          :status="aiStatus"
          :notice="aiNotice"
          :followup-busy="aiStreaming"
          :followup-enabled="llmEnabled && results.length > 0"
          :enabled="llmEnabled"
          :collapsed="aiCollapsed"
          @update:enabled="onLlmToggle"
          @update:collapsed="onAiCollapsedChange"
          @cite="onCite"
          @followup="onFollowUp"
        />
      </aside>
    </div>

    <!-- <lg 的「本次检索要点」抽屉（布局改造 2026-09-12）：
         选择抽屉而不是 Tab —— 结果列表与要点经常要对照着看（点 [来源n] 要能滚到对应卡片），
         Tab 会把两者变成互斥视图，对照就得来回切；抽屉浮在结果之上、关掉即回到原滚动位置。
         触发按钮只在「有要点，或 AI 已开启且有结果」时出现。 -->
    <button
      v-if="showAiDrawerTrigger"
      type="button"
      class="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-xs font-medium text-white shadow-floating transition-transform active:scale-[0.98] lg:hidden"
      aria-haspopup="dialog"
      :aria-expanded="aiDrawerOpen"
      @click="aiDrawerOpen = true"
    >
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
      <span>本次检索要点</span>
      <span v-if="aiStatus === 'done'" class="rounded bg-white/20 px-1.5 py-0.5 text-[10px]">已生成</span>
    </button>

    <Teleport to="body">
      <div v-if="aiDrawerOpen" class="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="本次检索要点">
        <!-- 遮罩：点击关闭 -->
        <div class="absolute inset-0 bg-slate-900/40" @click="aiDrawerOpen = false"></div>
        <!-- 底部抽屉：内容就是同一张 AiCompanionCard（不再有内联副本） -->
        <div class="absolute inset-x-0 bottom-0 max-h-[82vh] overflow-y-auto overscroll-contain rounded-t-2xl bg-canvas p-3 shadow-floating">
          <div class="mb-2 flex items-center justify-between px-1">
            <span class="text-xs font-medium text-ink-muted">本次检索要点</span>
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-canvas-subtle hover:text-ink-title"
              aria-label="关闭"
              @click="aiDrawerOpen = false"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          <AiCompanionCard
            :answer="aiAnswer"
            :citations="aiCitations"
            :model="aiModel"
            :streaming="loading || aiStreaming"
            :status="aiStatus"
            :notice="aiNotice"
            :followup-busy="aiStreaming"
            :followup-enabled="llmEnabled && results.length > 0"
            :enabled="llmEnabled"
            :collapsed="false"
            @update:enabled="onLlmToggle"
            @cite="onCiteFromDrawer"
            @followup="onFollowUp"
          />
        </div>
      </div>
    </Teleport>

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
import { useApi, isUnimplemented, isRateLimited, type SearchHit, type SearchResponse, type SearchRequest, type SearchTimings } from "~/composables/useApi"
import { useToast } from "~/composables/useToast"
import SearchBox from "~/components/SearchBox.vue"
import HitCard from "~/components/HitCard.vue"
import TimingsBar from "~/components/TimingsBar.vue"
import AiCompanionCard from "~/components/AiCompanionCard.vue"
import ConfirmDialog from "~/components/ConfirmDialog.vue"
import { TOP_K_ANON_MAX, TOP_K_MAX } from "~/composables/usePrefs"

type AiStatus = "idle" | "streaming" | "done" | "unavailable"

const { search, searchStream, chat } = useApi()
const { pushToast } = useToast()
const { prefs, load: loadPrefs, save: savePrefs } = usePrefs()
/** 「本次检索要点」是否收起（持久化在 usePrefs.aiCollapsed；≥lg 的侧栏卡片用它） */
const aiCollapsed = ref(false)
const { isLoggedIn, loadMe, isExceeded: authQuotaExceeded, resetInHours: authResetInHours, resetAtLabel: authResetAtLabel } =
  useAuth()

const searchBoxRef = ref<InstanceType<typeof SearchBox> | null>(null)
const loading = ref(false)
const hasSearched = ref(false)
const lastQuery = ref("")
const error = ref("")
const results = ref<SearchResponse["hits"]>([])
const responseTimings = ref<SearchTimings | null>(null)
const fallback = ref(false)
/** 服务端在 REQUIRE_LOGIN=1 时对匿名请求回 keywords 回退（warnings 含 "login-required"）→ 提示登录 */
const loginRequired = ref(false)
/** 未登录被后端夹取返回条数（警告码来自后端 topk.ts 的 ANON_TOP_K_WARNING） */
const topKClamped = computed(() => warnings.value.includes("top-k-clamped-anon"))
const quota = ref<SearchResponse["quota"] | null>(null)
const warnings = ref<string[]>([])
const highlightedHitId = ref<string | null>(null)

// ── 429 分档限流（plan-ratelimit.md §4/§6 的前端侧）──
// 后端 429 体：`{error:"rate-limited", tier, scope, retry_after}` + `Retry-After` / `X-RateLimit-Limit` 头。
// 三条硬要求：① **不清空已有结果**；② 明确提示（档位 + 限额 + 等待秒数）；③ retry_after 有值时倒计时并禁用提交。
// 注意：**额度耗尽**（`quota-exceeded`）也是 429，但语义完全不同（走回退检索、不封禁），
// 所以判定必须看 `code === "rate-limited"`（见 useApi.ts 的 `isRateLimited`），不能只看 status。
interface RateLimitState {
  /** 档位（overseas / unknown / cn_idc / …；后端可能省略 → 空串） */
  tier: string
  /** 作用域 tier-limit | burst | blocked | global-hard（后端可能省略 → 空串） */
  scope: string
  /** 本次生效限额（次/窗口；来自 X-RateLimit-Limit，缺失为 null） */
  limit: number | null
  /** 冷却截止时刻（epoch ms；0 = 后端没给 retry_after，不做倒计时） */
  untilMs: number
}

const rateLimit = ref<RateLimitState | null>(null)
const cooldownRemaining = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let dismissTimer: ReturnType<typeof setTimeout> | null = null

/** 档位中文名（与后端 `src/tiers.ts` 的 Tier 对应；未知档位回落到「当前网络」） */
const TIER_LABELS: Record<string, string> = {
  logged_in: "已登录用户",
  cn_residential: "境内家庭宽带",
  cn_other: "境内其它网络",
  cn_idc: "境内机房网络",
  overseas: "境外访客",
  unknown: "未识别网络",
}

/**
 * 引导登录的档位：额度最低的几档正是产品**有意**引导登录的对象（plan-ratelimit.md §12 风险 3）。
 * `cn_residential`（30/min）不在此列——对正常用户已经够用，不必打扰。
 */
const LOGIN_HINT_TIERS = ["overseas", "unknown", "cn_idc"]
/** 登录档默认额度（后端 `RATE_LIMIT_LOGGED_IN_PER_MIN` 默认 60 次/分钟） */
const LOGGED_IN_LIMIT_PER_MIN = 60

/** 限流提示正文：档位 + 限额 + 倒计时（倒计时结束后自动消失） */
const rateLimitMessage = computed(() => {
  const st = rateLimit.value
  if (!st) return ""
  const wait = cooldownRemaining.value > 0 ? `，请在 ${cooldownRemaining.value} 秒后重试` : "，请稍后重试"
  if (st.scope === "burst") return `请求过于频繁（短时间内提交过于集中，已触发突发限流）${wait}`
  if (st.scope === "blocked") return `该网络地址已被临时限制（约 1 分钟）${wait}`
  if (st.scope === "global-hard") return `服务当前繁忙（匿名访问量过高）${wait}`
  const label = TIER_LABELS[st.tier] ?? "当前网络"
  const perMin = st.limit !== null && st.limit > 0 ? `，${st.limit} 次/分钟` : ""
  return `请求过于频繁（当前档位：${label}${perMin}）${wait}`
})

/** 是否展示「登录后额度更高」引导（未登录 + 低额度档位；语气是提示不是威胁） */
const showLoginHint = computed(
  () => !isLoggedIn.value && !!rateLimit.value && LOGIN_HINT_TIERS.includes(rateLimit.value.tier),
)

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
// 额度耗尽：搜索响应里有就用它；否则用 `GET /me` 的权威视图 —— 搜索响应的 quota 只投影百分比
// （后端 `toQuotaResponse` 只看 used_pct/remaining_pct），`exceeded` 只在 /me 的完整视图里。
// 每次检索成功/结束后 index.vue 都会 `loadMe()` 刷新，所以这里的值紧跟当前窗口。
const quotaExceeded = computed(() => quota.value?.exceeded === true || authQuotaExceeded.value)

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

/**
 * 距重置的小时数：优先 `/me` 的**网格锚定**值（R6，重置时刻固定可预测）；
 * 退化路径保留旧契约（搜索响应里若有 window_start + window_hours 就现算）。
 */
const quotaResetHours = computed<number | null>(() => {
  const hours = authResetInHours.value
  if (hours !== null) return hours
  const q = quota.value
  if (!q || typeof q.window_start !== "number" || typeof q.window_hours !== "number") return null
  return Math.max(1, Math.ceil((q.window_start + q.window_hours * 3600e3 - Date.now()) / 3600e3))
})

/** 下次重置的本地时刻文案（HH:MM）；来自 /me 且**仅客户端**渲染（预渲染阶段为 null，防水合不一致） */
const quotaResetAtLabel = computed<string | null>(() => authResetAtLabel.value)

function onQuickSearch(queryText: string) {
  if (searchBoxRef.value) {
    searchBoxRef.value.setQuery(queryText)
    searchBoxRef.value.submit()
  }
}

/** 停掉倒计时（冷却结束 / 组件卸载 / 新一轮成功检索时调用） */
function stopCooldownTicker() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  if (dismissTimer) {
    clearTimeout(dismissTimer)
    dismissTimer = null
  }
}

/** 撤掉限流提示（冷却结束即恢复可提交状态；已有结果始终保留） */
function clearRateLimitNotice() {
  stopCooldownTicker()
  rateLimit.value = null
  cooldownRemaining.value = 0
}

/**
 * 收到 429（分档限流）时：记录档位/作用域/限额，按 `retry_after` 起倒计时。
 * 后端没给 `retry_after`（例如 KV 粗限流路径）时不做倒计时、不禁用提交，只把提示挂 12 秒。
 */
function applyRateLimit(err: unknown) {
  const e = err as { retryAfter?: unknown; tier?: unknown; scope?: unknown; limit?: unknown }
  const rawRetry = typeof e.retryAfter === "number" && Number.isFinite(e.retryAfter) ? e.retryAfter : 0
  const retryAfterSec = rawRetry > 0 ? Math.ceil(rawRetry) : 0
  stopCooldownTicker()
  rateLimit.value = {
    tier: typeof e.tier === "string" ? e.tier : "",
    scope: typeof e.scope === "string" ? e.scope : "",
    limit: typeof e.limit === "number" && Number.isFinite(e.limit) ? e.limit : null,
    untilMs: retryAfterSec > 0 ? Date.now() + retryAfterSec * 1000 : 0,
  }
  cooldownRemaining.value = retryAfterSec
  if (retryAfterSec > 0) {
    pushToast(`请求过于频繁，${retryAfterSec} 秒后可重试`, "warning")
    cooldownTimer = setInterval(() => {
      const st = rateLimit.value
      if (!st || st.untilMs <= 0) {
        clearRateLimitNotice()
        return
      }
      const remain = Math.max(0, Math.ceil((st.untilMs - Date.now()) / 1000))
      cooldownRemaining.value = remain
      if (remain <= 0) clearRateLimitNotice()
    }, 1000)
  } else {
    pushToast("请求过于频繁，请稍后重试", "warning")
    dismissTimer = setTimeout(clearRateLimitNotice, 12000)
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

// ── <lg 的「本次检索要点」抽屉（布局改造 2026-09-12）──
/** 抽屉开合（**不持久化**：它是移动端的临时视图，不是偏好） */
const aiDrawerOpen = ref(false)
/** 触发按钮出现条件：已有要点/正在生成，**或** AI 已开启且本次有结果 */
const showAiDrawerTrigger = computed(
  () => Boolean(aiAnswer.value) || aiStreaming.value || (llmEnabled.value && results.value.length > 0),
)

/** 抽屉里的 [来源n]：先收抽屉再滚动，否则抽屉盖住目标卡片看不到高亮 */
function onCiteFromDrawer(ref: string) {
  aiDrawerOpen.value = false
  window.setTimeout(() => scrollToHit(ref), 0)
}

/** 收起状态持久化（usePrefs.aiCollapsed；与设置页共用同一个偏好对象） */
function onAiCollapsedChange(v: boolean) {
  aiCollapsed.value = v
  savePrefs({ aiCollapsed: v })
}

/** 抽屉开着时按 Esc 关闭（遮罩点击已在模板里） */
function onDrawerKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape" && aiDrawerOpen.value) aiDrawerOpen.value = false
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
  if (isRateLimited(err)) {
    // 分档限流（llm 桶）：与「额度耗尽」是两回事，别混为一谈
    const retryAfter = (err as { retryAfter?: number })?.retryAfter
    const wait =
      typeof retryAfter === "number" && retryAfter > 0 ? `约 ${Math.ceil(retryAfter)} 秒后重试` : "稍后重试"
    return `请求过于频繁（AI 伴读按更紧的额度单独计数），${wait}。主检索结果不受影响。`
  }
  if (status === 429 || code === "quota-exceeded") return "本窗口额度已用尽，AI 总结暂不可用；回退检索不消耗额度。"
  if (code === "llm-unavailable" || code === "llm-upstream" || code === "llm-not-configured") {
    return "AI 总结暂不可用（上游模型不可用）。主检索结果不受影响。"
  }
  // 502/503/504（含反代透传的 upstream-unreachable）：上游抖动，给友好文案而不是甩原始错误
  if (status === 502 || status === 503 || status === 504 || code === "upstream-unreachable") {
    return "服务暂时不可用，请稍后重试。主检索结果不受影响。"
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
    if (res.citations?.length) aiCitations.value = Array.from(new Set([...aiCitations.value, ...res.citations]))
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
  // 冷却期内直接拦下（SearchBox 的按钮已禁用；这里兜住键盘回车等其它入口）
  if (cooldownRemaining.value > 0) {
    pushToast(`请求过于频繁，请在 ${cooldownRemaining.value} 秒后重试`, "warning")
    return
  }
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
    loginRequired.value = (res.warnings || []).includes("login-required")
    // 本轮成功 → 限流提示可以撤了（正常路径下冷却结束时就已清掉）
    if (rateLimit.value) clearRateLimitNotice()

    if (res.warnings?.length) {
      for (const w of res.warnings) {
        if (w === "login-required") {
          pushToast("未登录：当前为关键词回退检索；登录后解锁完整向量检索与 AI 伴读", "info")
        } else if (w.includes("fallback")) {
          pushToast("已自动切换至降级检索模式", "warning")
        }
      }
    }

    if (isLoggedIn.value) void loadMe()
  } catch (err: any) {
    if (isRateLimited(err)) {
      // 429 分档限流：**不清空已有结果**（error 保持空串，结果区继续渲染），只加一条明确提示 + 倒计时。
      // 额度耗尽（quota-exceeded）不走这里 —— 它由后端的回退分支返回，属于另一套语义。
      applyRateLimit(err)
    } else {
      // 上游抖动（含反代透传的 upstream-unreachable）→ 友好文案，不甩原始错误
      const status = (err as { status?: number })?.status
      const code = (err as { code?: string })?.code ?? ""
      const transient = status === 502 || status === 503 || status === 504 || code === "upstream-unreachable"
      error.value = transient ? "服务暂时不可用，请稍后重试" : err?.message || "网络请求异常，请稍后重试"
      results.value = []
      pushToast(error.value, "error")
    }
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
  aiCollapsed.value = saved.aiCollapsed === true
  window.addEventListener("keydown", onDrawerKeydown)
})

onBeforeUnmount(() => {
  cancelAiStream()
  stopCooldownTicker()
  window.removeEventListener("keydown", onDrawerKeydown)
})

// 偏好变更后同步（设置页可能在同一 SPA 会话里改过）
watch(prefs, (next) => {
  llmEnabled.value = next.llm
  aiCollapsed.value = next.aiCollapsed === true
})
</script>
