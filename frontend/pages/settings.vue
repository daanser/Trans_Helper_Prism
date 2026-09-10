<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 设置页（/settings，tasks.md T3.6 / T3.5）
     - 检索偏好（默认知识库 / 精准重排 / AI 伴读）只存 localStorage
     - 自定义模型（T3.5，后端已上线）：GET / POST / DELETE /api/v1/settings/models
       · 列表只展示元信息（名称 / 模型 / base_url / 是否已配置 key / 创建时间），**永不显示 key 明文**
       · 删除走 ConfirmDialog 二次确认；404 → 该模型不存在或已删除；401/403 → 需登录；503 → 服务端未配置加密密钥
     - 绝不把 api_key 写进 localStorage、绝不打印、提交后立刻从内存清空 -->
<template>
  <div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
    <header class="mb-8 flex flex-col">
      <!-- 页面级左上角返回（独立一行，与下方标题不挤） -->
      <BackButton class="mb-5 self-start" />

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
        当前未登录：可以正常检索（按 IP 限流）。登录后可解锁 AI 伴读与多轮追问，并在顶栏看到本窗口剩余额度百分比。
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

          <!-- 窗口起止与下次重置（本地时刻；R6 网格锚定 → 每次重置时刻固定可预测）
               ⚠️ 这些文案只在客户端挂载后渲染（useAuth 的 clientReady 门控），预渲染阶段为 null -->
          <dl
            v-if="windowStartLabel || resetAtLabel"
            class="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-surface-border pt-3 text-xs sm:grid-cols-2"
          >
            <div class="flex items-center justify-between gap-3">
              <dt class="text-ink-muted">本窗口起点</dt>
              <dd class="tabular-nums text-ink-sub">{{ windowStartLabel || "—" }}</dd>
            </div>
            <div class="flex items-center justify-between gap-3">
              <dt class="text-ink-muted">本窗口结束</dt>
              <dd class="tabular-nums text-ink-sub">{{ resetAtLabel || "—" }}</dd>
            </div>
            <div class="flex items-center justify-between gap-3 sm:col-span-2">
              <dt class="text-ink-muted">下次重置</dt>
              <dd class="tabular-nums font-medium text-ink-title">{{ resetText }}</dd>
            </div>
          </dl>
          <p v-if="windowStartLabel || resetAtLabel" class="mt-1.5 text-xs text-ink-muted">
            时刻按本机时区显示；本窗口长度 {{ windowLengthText }}，重置时刻由账号注册时间锚定，长期不变。
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

    <!-- 自定义模型（T3.5，后端已上线：GET / POST / DELETE /api/v1/settings/models） -->
    <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-2 border-b border-surface-border pb-3">
        <div>
          <h2 class="text-sm font-semibold text-ink-title">自定义模型</h2>
          <p class="mt-1 text-xs leading-relaxed text-ink-muted">
            接入你自己 OpenAI 兼容的模型服务。配置按账号隔离、仅本人可用；api_key 只在提交时使用一次，
            由服务端加密保存，页面与接口都永不回显。
          </p>
        </div>
        <div v-if="isLoggedIn" class="flex shrink-0 items-center gap-2">
          <StatusBadge :state="modelsState" />
          <button
            type="button"
            :disabled="modelsState === 'loading'"
            class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title disabled:pointer-events-none disabled:opacity-40"
            @click="loadModels"
          >
            刷新列表
          </button>
        </div>
      </div>

      <!-- 未登录：不请求列表，只显示登录引导 -->
      <div
        v-if="!isLoggedIn"
        class="rounded-xl border border-dashed border-surface-border bg-canvas-subtle/60 p-6 text-center"
      >
        <p class="text-sm font-semibold text-ink-title">登录后才能配置与查看自定义模型</p>
        <p class="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-sub">
          自定义模型配置按账号隔离（仅本人可用），因此需要先登录。未登录不影响检索本身。
        </p>
        <NuxtLink
          to="/login"
          class="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
        >
          去登录
        </NuxtLink>
      </div>

      <template v-else>
        <!-- 已保存的模型：加载中 / 接口未实现 / 加载失败 / 空 / 有数据 -->
        <div class="mb-5">
          <h3 class="mb-2 text-xs font-semibold text-ink-title">已保存的模型</h3>

          <p v-if="modelsState === 'loading'" class="text-xs text-ink-muted">加载中…</p>
          <p v-else-if="modelsState === 'unimplemented'" class="text-xs leading-relaxed text-ink-sub">
            接口未实现（后端返回 404/501）。
          </p>
          <p v-else-if="modelsState === 'error'" class="text-xs leading-relaxed text-red-600 dark:text-red-400">
            {{ modelsMessage }}
          </p>

          <div v-else-if="models.length" class="overflow-x-auto">
            <table class="w-full border-collapse text-xs">
              <thead>
                <tr class="border-b border-surface-border text-left text-ink-muted">
                  <th class="py-2 pr-3 font-medium">名称</th>
                  <th class="py-2 pr-3 font-medium">模型</th>
                  <th class="py-2 pr-3 font-medium">服务地址</th>
                  <th class="py-2 pr-3 font-medium">API Key</th>
                  <th class="py-2 pr-3 font-medium">创建时间</th>
                  <th class="py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in models" :key="m.id" class="border-b border-surface-border/60 text-ink-body">
                  <td class="py-2 pr-3 font-medium text-ink-title">{{ nameOf(m) }}</td>
                  <td class="py-2 pr-3 font-mono">{{ m.model || "—" }}</td>
                  <td class="max-w-[16rem] truncate py-2 pr-3 font-mono text-ink-sub" :title="m.base_url">
                    {{ m.base_url || "—" }}
                  </td>
                  <td class="py-2 pr-3">
                    <span
                      class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                      :class="m.key_configured ? 'bg-primary-subtle text-primary' : 'bg-canvas-subtle text-ink-muted'"
                    >
                      {{ m.key_configured ? "已配置" : "未配置" }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap py-2 pr-3 tabular-nums text-ink-sub">{{ timeText(m.created_at) }}</td>
                  <td class="py-2 text-right">
                    <button
                      type="button"
                      class="rounded-lg border border-red-500/30 px-2.5 py-1 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                      @click="askDelete(m)"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="mt-3 text-xs leading-relaxed text-ink-muted">
              服务端只返回「是否已配置 key」，不返回任何 key 明文或密文；删除后配置与密钥一并销毁，不可恢复。
            </p>
          </div>

          <p v-else class="text-xs leading-relaxed text-ink-muted">
            还没有已保存的自定义模型。用下面的表单添加一个，保存后即可在上方看到它。
          </p>
        </div>

        <!-- 新增 / 更新 -->
        <form class="space-y-3 border-t border-surface-border pt-5" @submit.prevent="submitModel">
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-ink-sub">名称（可选，仅用于本页展示）</span>
            <input
              v-model.trim="modelForm.name"
              type="text"
              autocomplete="off"
              placeholder="例如：自建 Qwen"
              class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 text-xs text-ink-body placeholder:text-ink-muted focus:border-primary focus:outline-none"
            />
          </label>

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
          说明：api_key 由服务端以 AES-GCM 加密落库且永不回显（本页只显示「已配置 / 未配置」）；
          自定义模型按账号隔离，其他账号无法读取或使用。
        </p>
      </template>
    </section>

    <!-- 删除二次确认：复用 ConfirmDialog -->
    <ConfirmDialog
      :open="deleteTarget !== null"
      title="删除这个自定义模型？"
      confirm-text="确认删除"
      cancel-text="取消"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    >
      <p>删除后该模型的配置与其加密保存的 API Key 会一并销毁，无法恢复；如需继续使用需重新填写。</p>
      <p v-if="deleteTarget" class="mt-2.5 rounded-lg border border-surface-border bg-canvas-subtle px-3 py-2 font-mono text-xs text-ink-sub">
        {{ nameOf(deleteTarget) }} · {{ deleteTarget.model || "—" }}
      </p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import {
  useApi,
  isUnimplemented,
  DEFAULT_CORPORA_OPTIONS,
  type CorpusOption,
  type CustomModelListItem,
} from "~/composables/useApi"
import { useToast } from "~/composables/useToast"
import ToggleMini from "~/components/ToggleMini.vue"
import ConfirmDialog from "~/components/ConfirmDialog.vue"
import StatusBadge from "~/components/StatusBadge.vue"

useHead({ title: "设置 · TransHelper Prism" })

/** 列表加载态（与 StatusBadge 的 LoadState 对齐） */
type ModelsState = "idle" | "loading" | "ok" | "unimplemented" | "error"

const { saveModelSettings, listModels, deleteModel } = useApi()
const { pushToast } = useToast()
const { prefs, load: loadPrefs, save, reset } = usePrefs()
const {
  isLoggedIn,
  user,
  quota,
  hasQuotaInfo,
  remainingPct,
  isLowQuota,
  isExceeded,
  resetInHours,
  resetAtLabel,
  windowStartLabel,
  loadMe,
  logout,
  init,
} = useAuth()

const corporaOptions: CorpusOption[] = DEFAULT_CORPORA_OPTIONS

const modelForm = reactive({ name: "", base_url: "", model: "", api_key: "" })
const modelSubmitting = ref(false)
const modelMessage = ref("")
const modelMessageTone = ref("text-ink-muted")
const createdText = ref("—")

/** 已保存的自定义模型（只含后端回的元信息，绝不含 key） */
const models = ref<CustomModelListItem[]>([])
const modelsState = ref<ModelsState>("idle")
const modelsMessage = ref("")
/** 待删除目标（非空即弹出二次确认） */
const deleteTarget = ref<CustomModelListItem | null>(null)
const deleting = ref(false)

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
  const at = resetAtLabel.value
  if (at && hours) return `本窗口额度已用尽，将于 ${at}（约 ${hours} 小时后）恢复。`
  if (hours) return `本窗口额度已用尽，约 ${hours} 小时后恢复。`
  return "本窗口额度已用尽。"
})

/** 下次重置的中文文案：优先给具体时刻（HH:MM），退化到"约 x 小时后"（仅客户端可得） */
const resetText = computed(() => {
  const at = resetAtLabel.value
  const hours = resetInHours.value
  if (at && hours) return `${at}（约 ${hours} 小时后）`
  if (at) return at
  if (hours) return `约 ${hours} 小时后`
  return "—"
})

/** 窗口长度文案（后端 env 可调 → 不写死 5；缺字段时退回中性说法） */
const windowLengthText = computed(() => {
  const h = quota.value?.window_hours
  return typeof h === "number" && Number.isFinite(h) && h > 0 ? `${h} 小时` : "固定长度"
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

/** 列表里的展示名（name 允许为空串，用「未命名」占位） */
function nameOf(item: CustomModelListItem): string {
  return item.name?.trim() || "未命名"
}

/** 只展示创建时间；时间戳在客户端格式化，避免预渲染时区不一致 */
function timeText(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return "—"
  const ms = n < 1e12 ? n * 1000 : n
  return new Date(ms).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })
}

/**
 * 自定义模型接口的错误文案。
 * 只说状态与后端错误码，**绝不回显任何 key 内容**：
 * 404 → 不存在或已删除；401/403 → 需登录；503 → 未配置加密密钥 / DB 不可用。
 */
function modelErrorText(err: unknown): string {
  const status = (err as { status?: number })?.status
  const code = (err as { code?: string })?.code ?? ""
  if (code === "invalid-base-url" || code === "insecure-base-url") return "base_url 不合法：仅支持 https 公网地址"
  if (code === "blocked-host") return "该地址被拒绝：不支持内网 / 回环 / 云元数据地址"
  if (code === "invalid-model") return "模型名不合法或缺少 API Key"
  if (status === 404) return "该模型不存在或已删除"
  if (status === 401 || status === 403) return "需要登录后才能使用自定义模型"
  if (status === 503) {
    return code === "db-unavailable"
      ? "服务端未配置加密密钥或数据库暂不可用，自定义模型暂不可用"
      : "服务端未配置加密密钥（CUSTOM_MODEL_ENC_KEY），自定义模型暂不可用"
  }
  if (isUnimplemented(err)) return "接口未实现（后端返回 404/501）"
  return `操作失败：${(err as Error)?.message || "未知错误"}`
}

/**
 * 拉取本人自定义模型列表。
 * 未登录直接返回且不发请求（避免无谓的 401）。
 */
async function loadModels() {
  if (!isLoggedIn.value) {
    models.value = []
    modelsState.value = "idle"
    modelsMessage.value = ""
    return
  }
  modelsState.value = "loading"
  modelsMessage.value = ""
  try {
    const res = await listModels()
    models.value = Array.isArray(res?.models) ? res.models : []
    modelsState.value = "ok"
  } catch (err: unknown) {
    models.value = []
    // 列表接口 404/501 = 后端未实现；其余按可读文案展示
    if (isUnimplemented(err)) modelsState.value = "unimplemented"
    else modelsState.value = "error"
    modelsMessage.value = isUnimplemented(err) ? "接口未实现（后端返回 404/501）。" : modelErrorText(err)
  }
}

async function submitModel() {
  if (modelSubmitting.value) return
  modelSubmitting.value = true
  modelMessage.value = ""
  try {
    await saveModelSettings({
      name: modelForm.name || undefined,
      base_url: modelForm.base_url,
      model: modelForm.model,
      api_key: modelForm.api_key,
    })
    modelMessage.value = "已保存"
    modelMessageTone.value = "text-primary"
    pushToast("自定义模型已保存", "info")
    // 保存成功后刷新列表（而不是只 toast），让新配置立刻可见
    await loadModels()
  } catch (err: unknown) {
    modelMessage.value = `保存失败：${modelErrorText(err)}`
    modelMessageTone.value = "text-danger"
    pushToast(modelMessage.value, "error")
  } finally {
    // 无论成败都清空 key 输入框：不留在页面 DOM / 内存里
    modelForm.api_key = ""
    modelSubmitting.value = false
  }
}

function askDelete(item: CustomModelListItem) {
  deleteTarget.value = item
}

function cancelDelete() {
  deleteTarget.value = null
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  try {
    await deleteModel(target.id)
    models.value = models.value.filter((m) => m.id !== target.id)
    pushToast(`已删除「${nameOf(target)}」`, "info")
    deleteTarget.value = null
  } catch (err: unknown) {
    pushToast(modelErrorText(err), "error")
    // 服务端已不存在（越权/已被删）→ 同步移除本地行，避免列表与服务端漂移
    if ((err as { status?: number })?.status === 404) {
      models.value = models.value.filter((m) => m.id !== target.id)
      deleteTarget.value = null
    }
  } finally {
    deleting.value = false
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

/** 登录状态变化：登录后拉列表，登出后清空（清单只属于当前账号） */
watch(isLoggedIn, (logged) => {
  if (logged) void loadModels()
  else {
    models.value = []
    modelsState.value = "idle"
    modelsMessage.value = ""
    deleteTarget.value = null
  }
})

onMounted(async () => {
  loadPrefs()
  // init()：页面 onMounted 早于 app.vue，需要先把 localStorage 里的 token 同步进响应式状态
  init()
  if (isLoggedIn.value) {
    await loadMe()
    await loadModels()
  }
  syncCreated()
})
</script>
