<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 设置页（/settings，tasks.md T3.6 / T3.5）
     - 检索偏好（默认知识库 / 精准重排 / AI 伴读）只存 localStorage
     - 自定义模型（base_url + model + api_key）提交到 POST /api/v1/settings/model；后端未定稿 → 404/501 显示「接口未实现」
     - 绝不把 api_key 写进 localStorage、绝不打印、提交后立刻从内存清空 -->
<template>
  <div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
    <header class="mb-8">
      <h1 class="text-2xl font-bold tracking-tight text-ink-title sm:text-3xl">设置</h1>
      <p class="mt-2 text-sm leading-relaxed text-ink-sub">
        这里的偏好只保存在本机浏览器；账号与配额信息来自服务端。
      </p>
    </header>

    <!-- 账号与配额 -->
    <section class="mb-6 rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
      <div class="mb-4 flex items-center justify-between border-b border-surface-border pb-3">
        <h2 class="text-sm font-semibold text-ink-title">账号与配额</h2>
        <NuxtLink v-if="!isLoggedIn" to="/login" class="text-xs font-medium text-primary hover:underline">
          去登录
        </NuxtLink>
      </div>

      <div v-if="!isLoggedIn" class="text-xs leading-relaxed text-ink-sub">
        当前未登录：检索自动走回退模式。登录后可获得每月配额，并开启 AI 伴读与追问。
      </div>

      <div v-else class="space-y-4">
        <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <div class="flex items-center justify-between gap-3">
            <dt class="text-ink-muted">账号</dt>
            <dd class="font-medium text-ink-title">@{{ user?.handle || "—" }}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-ink-muted">角色</dt>
            <dd class="font-medium text-ink-title">{{ roleText }}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-ink-muted">账号 ID（脱敏）</dt>
            <dd class="font-mono text-ink-sub">{{ maskedAccountId }}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-ink-muted">注册时间</dt>
            <dd class="text-ink-sub">{{ createdText }}</dd>
          </div>
        </dl>

        <!-- 配额条（只显示百分比；字段缺失时整块隐藏） -->
        <div v-if="hasQuotaInfo">
          <div class="mb-1.5 flex items-center justify-between text-xs">
            <span class="text-ink-muted">本窗口剩余额度</span>
            <span class="tabular-nums" :class="isExceeded || isLowQuota ? 'font-medium text-danger' : 'text-ink-title'">
              {{ quotaText }}
            </span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-canvas-subtle">
            <div
              class="h-full rounded-full transition-all"
              :class="isExceeded || isLowQuota ? 'bg-danger' : 'bg-primary'"
              :style="{ width: `${remainingPct ?? 0}%` }"
            ></div>
          </div>
          <p v-if="isExceeded" class="mt-1.5 text-xs text-danger">
            {{ exceededText }}
          </p>
          <p v-else-if="isLowQuota" class="mt-1.5 text-xs text-danger">
            剩余额度已低于 10%，超出后将自动切换为回退检索（回退不消耗额度）。
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2 border-t border-surface-border pt-4">
          <button
            type="button"
            class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
            @click="refreshAccount"
          >
            刷新账号信息
          </button>
          <button
            type="button"
            class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-danger hover:text-danger"
            @click="onLogout"
          >
            退出登录
          </button>
        </div>
      </div>
    </section>

    <!-- 检索偏好 -->
    <section class="mb-6 rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
      <div class="mb-4 border-b border-surface-border pb-3">
        <h2 class="text-sm font-semibold text-ink-title">检索偏好</h2>
        <p class="mt-1 text-xs text-ink-muted">保存在本机浏览器，用于新一次检索的默认值。</p>
      </div>

      <div class="space-y-5">
        <div>
          <span class="mb-2 block text-xs font-medium text-ink-sub">默认知识库</span>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="c in corporaOptions"
              :key="c.id"
              type="button"
              :title="c.desc"
              :aria-pressed="prefs.corpora.includes(c.id)"
              class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all"
              :class="
                prefs.corpora.includes(c.id)
                  ? 'border-blue-500/40 bg-blue-50/80 text-blue-700 shadow-sm dark:border-blue-400/30 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-surface-border bg-canvas-subtle text-ink-muted hover:border-surface-border-hover hover:text-ink-sub'
              "
              @click="toggleCorpus(c.id)"
            >
              <svg
                v-if="prefs.corpora.includes(c.id)"
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

        <div class="flex flex-col gap-3 border-t border-surface-border pt-4">
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
              <p class="text-xs font-medium text-ink-title">默认开启精准重排</p>
              <p class="mt-0.5 text-xs text-ink-muted">使用 BAAI/bge-reranker-v2-m3 对候选结果二次排序，结果更准、耗时略增。</p>
            </div>
            <ToggleMini :model-value="prefs.reranker" label="" @update:model-value="(v: boolean) => save({ reranker: v })" />
          </div>

          <div class="flex items-center justify-between gap-4 border-t border-surface-border pt-3">
            <div class="min-w-0">
              <p class="text-xs font-medium text-ink-title">默认开启 AI 伴读</p>
              <p class="mt-0.5 text-xs text-ink-muted">
                开启后，搜索页的 AI 伴读开关默认打开（每次总结与追问仍会弹出确认，并按 token 消耗配额）。
              </p>
            </div>
            <ToggleMini :model-value="prefs.llm" label="" @update:model-value="(v: boolean) => save({ llm: v })" />
          </div>
        </div>

        <div class="flex items-center gap-2 border-t border-surface-border pt-4">
          <button
            type="button"
            class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
            @click="onResetPrefs"
          >
            恢复默认偏好
          </button>
        </div>
      </div>
    </section>

    <!-- 自定义模型（T3.5，后端未定稿） -->
    <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
      <div class="mb-4 border-b border-surface-border pb-3">
        <h2 class="text-sm font-semibold text-ink-title">自定义模型</h2>
        <p class="mt-1 text-xs leading-relaxed text-ink-muted">
          接入你自己 OpenAI 兼容的模型服务。api_key 只在本页提交时使用一次，不会写入本机存储，也不会回显。
        </p>
      </div>

      <form class="space-y-3" @submit.prevent="submitModel">
        <label class="block">
          <span class="mb-1 block text-xs font-medium text-ink-sub">服务地址 base_url</span>
          <input
            v-model.trim="modelForm.base_url"
            type="url"
            required
            placeholder="https://api.example.com/v1"
            autocomplete="off"
            class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 text-xs text-ink-body placeholder:text-ink-muted focus:border-primary focus:outline-none"
          />
        </label>

        <label class="block">
          <span class="mb-1 block text-xs font-medium text-ink-sub">模型名称 model</span>
          <input
            v-model.trim="modelForm.model"
            type="text"
            required
            placeholder="qwen3-8b / gpt-4o-mini …"
            autocomplete="off"
            class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 text-xs text-ink-body placeholder:text-ink-muted focus:border-primary focus:outline-none"
          />
        </label>

        <label class="block">
          <span class="mb-1 block text-xs font-medium text-ink-sub">API Key</span>
          <input
            v-model="modelForm.api_key"
            type="password"
            required
            autocomplete="new-password"
            placeholder="仅提交给后端加密保存，不在浏览器留存"
            class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 font-mono text-xs text-ink-body placeholder:font-sans placeholder:text-ink-muted focus:border-primary focus:outline-none"
          />
        </label>

        <div class="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="submit"
            :disabled="modelSubmitting"
            class="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
          >
            {{ modelSubmitting ? "提交中…" : "保存模型配置" }}
          </button>
          <span v-if="modelMessage" class="text-xs" :class="modelMessageTone">{{ modelMessage }}</span>
        </div>
      </form>

      <p class="mt-4 border-t border-surface-border pt-3 text-xs leading-relaxed text-ink-muted">
        说明：后端自定义模型接口（POST /api/v1/settings/model）尚未定稿，返回 404/501 时本页会提示「接口未实现」，
        此时配置不会生效，检索仍使用平台默认模型。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import { useApi, isUnimplemented, DEFAULT_CORPORA_OPTIONS, type CorpusOption } from "~/composables/useApi"
import { useToast } from "~/composables/useToast"
import ToggleMini from "~/components/ToggleMini.vue"

useHead({ title: "设置 · TransHelper Prism" })

const { saveModelSettings } = useApi()
const { pushToast } = useToast()
const { prefs, load: loadPrefs, save, reset } = usePrefs()
const { isLoggedIn, user, hasQuotaInfo, remainingPct, isLowQuota, isExceeded, resetInHours, loadMe, logout, init } = useAuth()

const corporaOptions: CorpusOption[] = DEFAULT_CORPORA_OPTIONS

const modelForm = reactive({ base_url: "", model: "", api_key: "" })
const modelSubmitting = ref(false)
const modelMessage = ref("")
const modelMessageTone = ref("text-ink-muted")
const createdText = ref("—")

const roleText = computed(() => {
  const role = user.value?.role
  if (role === "admin") return "管理员"
  if (role === "user") return "普通用户"
  return role || "—"
})

/** 账号 id 脱敏展示（隐私底线：后台/前端都不显示完整标识） */
const maskedAccountId = computed(() => {
  const id = user.value?.account_id
  if (!id) return "—"
  if (id.length <= 10) return `${id.slice(0, 3)}…`
  return `${id.slice(0, 6)}…${id.slice(-4)}`
})

/** 配额文案：只出现百分比（滚动窗口固定额度） */
const quotaText = computed(() => {
  if (isExceeded.value) return "已用尽"
  const pct = remainingPct.value
  return pct === null ? "" : `剩余 ${pct.toFixed(1)}%`
})

const exceededText = computed(() => {
  const hours = resetInHours.value
  return hours ? `本窗口额度已用尽，约 ${hours} 小时后恢复。` : "本窗口额度已用尽。"
})

function toggleCorpus(id: string) {
  const current = prefs.value.corpora
  if (current.includes(id)) {
    if (current.length <= 1) {
      pushToast("请至少保留一个知识库", "warning")
      return
    }
    save({ corpora: current.filter((c) => c !== id) })
  } else {
    save({ corpora: [...current, id] })
  }
}

function onResetPrefs() {
  reset()
  pushToast("已恢复默认检索偏好", "info")
}

async function refreshAccount() {
  const ok = await loadMe()
  pushToast(ok ? "账号信息已刷新" : "账号信息刷新失败", ok ? "info" : "error")
}

function onLogout() {
  logout()
  pushToast("已退出登录", "info")
}

async function submitModel() {
  if (modelSubmitting.value) return
  modelSubmitting.value = true
  modelMessage.value = ""
  try {
    await saveModelSettings({
      base_url: modelForm.base_url,
      model: modelForm.model,
      api_key: modelForm.api_key,
    })
    modelMessage.value = "已保存"
    modelMessageTone.value = "text-primary"
    pushToast("自定义模型配置已提交", "info")
  } catch (err: unknown) {
    if (isUnimplemented(err)) {
      modelMessage.value = "接口未实现（后端 T3.5 待实现），配置暂未生效"
    } else {
      // 只回显状态与后端泛化原因，绝不回显 key
      modelMessage.value = `保存失败：${(err as Error)?.message || "未知错误"}`
    }
    modelMessageTone.value = "text-danger"
    pushToast(modelMessage.value, "error")
  } finally {
    // 无论成败都清空 key 输入框：不留在页面 DOM / 内存里
    modelForm.api_key = ""
    modelSubmitting.value = false
  }
}

/** 注册时间只在客户端格式化，避免预渲染时区不一致导致 hydration 不匹配 */
function syncCreated() {
  const createdAt = user.value?.created_at
  createdText.value = createdAt
    ? new Date(createdAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })
    : "—"
}

watch(user, syncCreated)

onMounted(async () => {
  loadPrefs()
  // init()：页面 onMounted 早于 app.vue，需要先把 localStorage 里的 token 同步进响应式状态
  init()
  if (isLoggedIn.value) {
    await loadMe()
  }
  syncCreated()
})
</script>
