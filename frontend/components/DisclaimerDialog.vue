<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 免责声明弹窗（首次访问默认弹出；视觉语言对齐 ConfirmDialog）
     ── 交互约定（都是有意的，改动前先读）──
     1. **Esc = 本次关闭**（只写 sessionStorage，下次访问还会弹）：Esc 是"躲开"而不是"同意"。
     2. **点遮罩不关闭**：同意的动作必须显式 —— 误触遮罩被当成"我知道了，不再提示"，
        等于用户在最需要知情的那一刻被静默代签。所以这里**故意不写** `@click.self`。
     3. 主按钮「我知道了，不再提示」→ ack()（localStorage + sessionStorage + 已登录时同步账号）。
     4. 次按钮「本次关闭」→ dismissForSession()；「查看完整免责声明」→ 先去 /about，
        并顺带按"本次关闭"处理（否则弹窗会一直盖住 /about，用户根本读不到全文）。
     5. 深色/浅色只用 surface / ink-* / primary 语义 token，不写死浅色。 -->
<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="visible"
        class="fixed inset-0 z-[95] flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="disclaimer-dialog-title"
        aria-describedby="disclaimer-dialog-body"
      >
        <div class="my-auto w-full max-w-lg rounded-2xl border border-surface-border bg-surface p-5 shadow-floating sm:p-6">
          <h2 id="disclaimer-dialog-title" class="flex items-center gap-2 text-base font-semibold text-ink-title">
            <span aria-hidden="true">⚠️</span>
            <span>使用前请知悉</span>
          </h2>

          <div id="disclaimer-dialog-body" class="mt-3 text-sm leading-relaxed text-ink-sub">
            <ul class="list-disc space-y-2 pl-5">
              <li>
                <strong class="font-medium text-ink-body">AI 回答由模型生成，可能出错或过时</strong>，
                不能替代医生的建议；请以检索到的原文与执业医生判断为准。
              </li>
              <li>
                涉及<strong class="font-medium text-ink-body">用药、剂量、检查、手术</strong>等决定，请先咨询医生；
                紧急情况请立即就医。
              </li>
              <li>
                回答里的 <span class="font-medium text-ink-body">[来源n]</span> 标注
                <strong class="font-medium text-ink-body">可以点击回跳原文</strong>，建议核对原文再行动。
              </li>
              <li>
                本站<strong class="font-medium text-ink-body">只索引开源 wiki、不生产内容</strong>；
                隐私上只保存 X 账号 id 的 <strong class="font-medium text-ink-body">SHA-256 摘要</strong>，
                不收集手机号、邮箱或实名信息。
              </li>
            </ul>
          </div>

          <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <NuxtLink
              to="/about"
              class="text-xs font-medium text-primary hover:underline sm:order-1"
              @click="onReadFull"
            >
              查看完整免责声明
            </NuxtLink>

            <div class="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:order-2">
              <button
                type="button"
                class="rounded-lg border border-surface-border bg-surface px-4 py-2 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
                @click="onDismiss"
              >
                本次关闭
              </button>
              <button
                ref="ackBtn"
                type="button"
                class="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
                @click="onAck"
              >
                我知道了，不再提示
              </button>
            </div>
          </div>

          <p class="mt-3 text-[11px] leading-relaxed text-ink-muted">
            选「我知道了，不再提示」会在本设备记住；登录后还会同步到账号，换设备也不再弹。
            想再看一遍可在<NuxtLink to="/settings" class="text-primary hover:underline" @click="onDismiss">设置</NuxtLink>里重新打开。
          </p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

const { shouldShow, load, ack, dismissForSession } = useDisclaimer()
// 已登录时 /me（含服务端 disclaimer_ack）正在路上 → **先别弹**：否则在别的设备已确认过的用户
// 会先看到弹窗、几百毫秒后又消失（闪一下）。`loading` 是 useAuth 的共享状态，未登录时恒为 false。
const { loading: authLoading } = useAuth()
const visible = computed(() => shouldShow.value && !authLoading.value)

const ackBtn = ref<HTMLButtonElement | null>(null)

/** 只在弹窗可见期间监听 Esc：Esc = 本次关闭（不是"同意"）。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && visible.value) onDismiss()
}

function onAck() {
  ack()
}

function onDismiss() {
  dismissForSession()
}

/** 去 /about 读全文：按"本次关闭"处理，否则弹窗会盖住正文。 */
function onReadFull() {
  dismissForSession()
}

onMounted(() => {
  // 客户端读一次存储（幂等）；预渲染期 load() 内部直接返回，不会碰 window
  load()
  window.addEventListener("keydown", onKeydown)
})

onBeforeUnmount(() => {
  if (import.meta.client) window.removeEventListener("keydown", onKeydown)
})

// 打开时把焦点落到主按钮（键盘用户可直接回车确认；不自动确认，只是聚焦）
watch(visible, (open) => {
  if (!import.meta.client || !open) return
  nextTick(() => ackBtn.value?.focus())
})
</script>
