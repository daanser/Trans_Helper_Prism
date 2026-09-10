<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 登录页（/login，tasks.md T3.6）
     - 后端登录成功后 302 回 {FRONTEND_BASE_URL}/login#token=<JWT>，失败回 #error=<code>
     - 本页读 location.hash：拿到 token → 存 localStorage（prism_token）+ 立刻清 hash → 跳首页
     - 无参数时展示登录引导（说明 X 登录只取 id + handle，见 tasks.md T3.1 隐私底线） -->
<template>
  <div class="mx-auto flex max-w-2xl flex-col items-center px-4 py-16 sm:py-24">
    <div class="w-full rounded-2xl border border-surface-border bg-surface p-6 shadow-card sm:p-10">
      <!-- 状态图标 -->
      <div
        class="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl"
        :class="toneBoxClass"
      >
        <svg
          v-if="state === 'error'"
          class="h-6 w-6"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
        <svg
          v-else-if="state === 'success'"
          class="h-6 w-6"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <svg
          v-else
          class="h-6 w-6"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </div>

      <h1 class="text-center text-xl font-bold tracking-tight text-ink-title sm:text-2xl">
        {{ heading }}
      </h1>
      <p class="mx-auto mt-3 max-w-md text-center text-sm leading-relaxed text-ink-sub">
        {{ description }}
      </p>

      <!-- 错误态：可重试 -->
      <div v-if="state === 'error'" class="mt-6 flex flex-col items-center gap-2">
        <button
          type="button"
          class="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          @click="startLogin"
        >
          重新登录
        </button>
        <NuxtLink to="/" class="text-xs text-ink-muted transition-colors hover:text-ink-title">
          先返回首页
        </NuxtLink>
      </div>

      <!-- 成功态：自动跳转 -->
      <div v-else-if="state === 'success'" class="mt-6 text-center">
        <NuxtLink to="/" class="text-sm font-medium text-primary hover:underline">
          正在返回首页…
        </NuxtLink>
      </div>

      <!-- 引导态：登录入口 + 隐私说明 -->
      <div v-else class="mt-7 flex flex-col items-center gap-3">
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
          @click="startLogin"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z" />
          </svg>
          <span>使用 X 账号登录</span>
        </button>
        <NuxtLink to="/" class="text-xs text-ink-muted transition-colors hover:text-ink-title">
          不登录，直接开始检索
        </NuxtLink>
      </div>

      <!-- 隐私说明（T3.1 底线） -->
      <ul class="mt-8 space-y-2 border-t border-surface-border pt-5 text-xs leading-relaxed text-ink-muted">
        <li>· 登录仅用于额度计量与防滥用：不要求实名、不收集手机号、不绑定邮箱。</li>
        <li>· 身份识别仅使用 X 账号 id 与用户名；数据库只存 id 的 sha256 摘要，不保存用户名，也不保存你的帖子或关注关系。</li>
        <li>· 未登录也能搜索——走的是完整向量检索，只是按 IP 限流；登录后额外解锁 AI 伴读与追问，并显示本窗口剩余额度。</li>
        <li>· 会话凭据只存在你自己的浏览器本地，30 天有效；点顶栏「退出」即可随时清除。</li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { describeAuthError } from "~/composables/useAuth"

useHead({ title: "登录 · TransHelper Prism" })

const { consumeHashToken, login, isLoggedIn, loadMe, init } = useAuth()
const { pushToast } = useToast()

type LoginState = "guide" | "success" | "error"
const state = ref<LoginState>("guide")
const errorText = ref("")

const heading = computed(() => {
  if (state.value === "success") return "登录成功"
  if (state.value === "error") return "登录未完成"
  return "登录 TransHelper Prism"
})

const description = computed(() => {
  if (state.value === "success") return "正在返回首页，你的会话与剩余配额会显示在顶部导航栏。"
  if (state.value === "error") return errorText.value
  return "登录后可解锁 AI 伴读与多轮追问，顶栏会显示本窗口剩余额度百分比，并可在设置页保存个人检索偏好。不登录也能正常搜索。"
})

const toneBoxClass = computed(() => {
  if (state.value === "error") return "bg-danger-subtle text-danger"
  if (state.value === "success") return "bg-primary-subtle text-primary"
  return "bg-primary-subtle text-primary"
})

function startLogin() {
  // 回跳本页：后端会把 token 以 #token= 形式拼回来，由本页 onMounted 接管
  login("/login")
}

onMounted(async () => {
  const result = consumeHashToken()
  if (result?.token) {
    state.value = "success"
    pushToast("登录成功", "info")
    await loadMe()
    await navigateTo("/")
    return
  }
  if (result?.error) {
    state.value = "error"
    errorText.value = describeAuthError(result.error)
    pushToast(errorText.value, "error")
    return
  }
  // 已登录用户直接回首页（例如手动访问 /login）
  if (init() && isLoggedIn.value) {
    state.value = "success"
    await loadMe()
    await navigateTo("/")
  }
})
</script>
