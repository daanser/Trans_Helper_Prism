<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 管理页骨架（/admin，tasks.md T3.6；后端 T3.3 正在实现）
     - 用量 / key 池 / 封禁 / 加额 四块，各自独立容错：404/501 显示「接口未实现」
     - 本页不实现真实权限逻辑（后端兜底）；前端只做角色提示
     - 安全：渲染任何后端字段前都过滤 key/secret/token 类字段，绝不显示 key 明文 -->
<template>
  <div class="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
    <header class="mb-8 flex flex-col">
      <!-- 页面级左上角返回（独立一行，与下方标题/徽章不挤） -->
      <BackButton class="mb-5 self-start" />

      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-bold tracking-tight text-ink-title sm:text-3xl">管理后台</h1>
        <span class="rounded-md border border-surface-border bg-canvas-subtle px-2 py-0.5 text-[11px] font-medium text-ink-sub">
          骨架页 · 运维接口需 ADMIN_API_KEY
        </span>
      </div>
      <p class="mt-2 text-sm leading-relaxed text-ink-sub">
        用量、封禁、加额与 key 池管理。所有接口都会独立探测：未实现（404/501）时本页如实提示，不做任何前端假数据。封禁/加额/审计为服务端 ADMIN_API_KEY 保护的运维接口，浏览器会话无权调用时本页会如实说明。
      </p>
    </header>

    <!-- 未登录 -->
    <div v-if="!isLoggedIn" class="rounded-2xl border border-dashed border-surface-border bg-surface p-8 text-center">
      <p class="text-sm font-semibold text-ink-title">需要登录后才能访问管理后台</p>
      <p class="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-sub">
        管理操作会写入审计日志（T3.3），因此必须使用账号登录。
      </p>
      <NuxtLink
        to="/login"
        class="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
      >
        去登录
      </NuxtLink>
    </div>

    <!-- 已登录但非管理员 -->
    <div v-else-if="!isAdmin" class="rounded-2xl border border-danger/30 bg-danger-subtle p-6">
      <p class="text-sm font-semibold text-danger">无权访问</p>
      <p class="mt-1.5 text-xs leading-relaxed text-ink-body">
        当前账号（@{{ user?.handle || "—" }}）不是管理员。真实权限校验由后端完成，即使直接访问本页也无法调用管理接口。
      </p>
      <NuxtLink to="/" class="mt-3 inline-flex text-xs font-medium text-primary hover:underline">返回检索首页</NuxtLink>
    </div>

    <div v-else class="space-y-6">
      <!-- 用量 -->
      <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-surface-border pb-3">
          <div>
            <h2 class="text-sm font-semibold text-ink-title">用量</h2>
            <p class="mt-0.5 text-xs text-ink-muted">GET /api/v1/admin/usage</p>
          </div>
          <div class="flex items-center gap-2">
            <StatusBadge :state="usageState" />
            <button
              type="button"
              class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
              @click="loadUsage"
            >
              刷新
            </button>
          </div>
        </div>

        <p v-if="usageState === 'loading'" class="text-xs text-ink-muted">加载中…</p>
        <p v-else-if="usageState === 'unimplemented'" class="text-xs leading-relaxed text-ink-sub">
          接口未实现（后端返回 404/501）。用量明细接入后，这里会按账号展示已用/剩余配额与请求数。
        </p>
        <p v-else-if="usageState === 'error'" class="text-xs text-danger">{{ usageMessage }}</p>
        <div v-else-if="usageRows.length" class="overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr class="border-b border-surface-border text-left text-ink-muted">
                <th class="py-2 pr-3 font-medium">账号</th>
                <th class="py-2 pr-3 font-medium">已用</th>
                <th class="py-2 pr-3 font-medium">剩余</th>
                <th class="py-2 font-medium">请求数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in usageRows" :key="i" class="border-b border-surface-border/60 text-ink-body">
                <td class="py-2 pr-3 font-mono">{{ maskId(row.account_id) }}</td>
                <td class="py-2 pr-3 tabular-nums">{{ row.used }}</td>
                <td class="py-2 pr-3 tabular-nums">{{ row.remaining }}</td>
                <td class="py-2 tabular-nums">{{ row.requests }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <pre v-else-if="usageRaw" class="overflow-x-auto rounded-lg border border-surface-border bg-canvas-subtle p-3 font-mono text-[11px] leading-relaxed text-ink-sub">{{ usageRaw }}</pre>

        <!-- 分档限流观测（plan-ratelimit.md §10 R5）：与用量同一个「各自独立探测」模式 -->
        <div class="mt-6 border-t border-surface-border pt-4">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 class="text-sm font-semibold text-ink-title">分档限流观测</h3>
              <p class="mt-0.5 text-xs text-ink-muted">
                GET /api/v1/admin/ratelimit · 只读聚合 rate_counters（不产生任何写入，不含 IP 与桶 key）
              </p>
            </div>
            <div class="flex items-center gap-2">
              <StatusBadge :state="ratelimitState" />
              <button
                type="button"
                class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
                @click="loadRatelimit"
              >
                刷新
              </button>
            </div>
          </div>

          <p v-if="ratelimitState === 'loading'" class="text-xs text-ink-muted">加载中…</p>
          <p v-else-if="ratelimitState === 'unimplemented'" class="text-xs leading-relaxed text-ink-sub">
            接口未实现（后端返回 404/501）。该端点上线后，这里会显示各档位/各作用域的桶数与计数、封禁中的地址数，以及全局匿名熔断状态。
          </p>
          <p v-else-if="ratelimitState === 'error'" class="text-xs text-danger">{{ ratelimitMessage }}</p>
          <template v-else-if="ratelimitData">
            <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-sub">
              <span>计数窗口：<b class="font-medium text-ink-title">{{ ratelimitWindowSec }}</b> 秒</span>
              <span>封禁中：<b class="font-medium text-ink-title">{{ ratelimitBlocked }}</b> 个网络地址</span>
              <span>
                全局匿名熔断：<b class="font-medium" :class="ratelimitGlobalTone">{{ ratelimitGlobalText }}</b>
                <span class="text-ink-muted">（{{ ratelimitGlobalCount }} / 软 {{ ratelimitGlobalSoft }} / 硬 {{ ratelimitGlobalHard }}）</span>
              </span>
            </div>
            <p v-if="ratelimitData.degraded" class="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              降级：未配置 PROXY_SHARED_SECRET → 计数桶的匿名化强度下降（桶名可被穷举反查）。请在生产配置该 secret。
            </p>

            <p class="mb-1.5 text-xs font-medium text-ink-sub">各作用域（当前窗口 + 上一窗口）</p>
            <div class="mb-4 overflow-x-auto">
              <table class="w-full border-collapse text-xs">
                <thead>
                  <tr class="border-b border-surface-border text-left text-ink-muted">
                    <th class="py-2 pr-3 font-medium">作用域</th>
                    <th class="py-2 pr-3 font-medium">桶数</th>
                    <th class="py-2 font-medium">计数</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in ratelimitScopeRows" :key="row.key" class="border-b border-surface-border/60 text-ink-body">
                    <td class="py-2 pr-3">{{ row.label }}</td>
                    <td class="py-2 pr-3 tabular-nums">{{ row.buckets }}</td>
                    <td class="py-2 tabular-nums">{{ row.counted }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p class="mb-1.5 text-xs font-medium text-ink-sub">各档位（search + LLM 桶合并）</p>
            <div v-if="ratelimitTierRows.length" class="overflow-x-auto">
              <table class="w-full border-collapse text-xs">
                <thead>
                  <tr class="border-b border-surface-border text-left text-ink-muted">
                    <th class="py-2 pr-3 font-medium">档位</th>
                    <th class="py-2 pr-3 font-medium">桶数</th>
                    <th class="py-2 pr-3 font-medium">计数</th>
                    <th class="py-2 font-medium">限额（次/分钟）</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in ratelimitTierRows" :key="row.tier" class="border-b border-surface-border/60 text-ink-body">
                    <td class="py-2 pr-3">{{ row.label }}</td>
                    <td class="py-2 pr-3 tabular-nums">{{ row.buckets }}</td>
                    <td class="py-2 pr-3 tabular-nums">{{ row.counted }}</td>
                    <td class="py-2 tabular-nums">{{ row.limit }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="text-xs text-ink-muted">当前窗口内没有计数行（尚无受限请求，属正常态）。</p>
          </template>
        </div>
      </section>

      <!-- Key 池 -->
      <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-surface-border pb-3">
          <div>
            <h2 class="text-sm font-semibold text-ink-title">Key 池</h2>
            <p class="mt-0.5 text-xs text-ink-muted">GET /api/v1/admin/keys · 只显示标识与用量，永不显示 key 明文</p>
          </div>
          <div class="flex items-center gap-2">
            <StatusBadge :state="keysState" />
            <button
              type="button"
              class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
              @click="loadKeys"
            >
              刷新
            </button>
          </div>
        </div>

        <!-- 补货提示（plan.md §8.4「可用 key 数 < 2 就通知补货」）：**警示**不是错误，故用警示色而非 danger -->
        <div
          v-if="understockedPools.length"
          class="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 dark:border-amber-900/40 dark:bg-amber-950/30"
          role="status"
        >
          <span class="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-200">
            需补货
          </span>
          <div class="min-w-0 space-y-1">
            <p class="text-xs font-medium leading-relaxed text-amber-900 dark:text-amber-100">
              <template v-for="(p, i) in understockedPools" :key="p.pool">
                <span v-if="i > 0">、</span><span class="font-semibold">{{ p.pool }}</span>
              </template>
              池可用 key 不足 2 把，请补货。
            </p>
            <p class="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
              池里只剩单把 key 时，这把 key 被上游限流或失效就只能降级：<b>AI 伴读会不可用</b>
              （我们演练过这条路：AI 报错但<b>检索不受影响</b>，会自动回退关键词检索）。
              建议至少配 2 把（<code class="font-mono">POOL_KEYS_0</code> /
              <code class="font-mono">POOL_KEYS_1</code>，一把一个变量），换 key 时才有退路。
            </p>
          </div>
        </div>

        <p v-if="keysState === 'loading'" class="text-xs text-ink-muted">加载中…</p>
        <p v-else-if="keysState === 'unimplemented'" class="text-xs leading-relaxed text-ink-sub">
          接口未实现（后端返回 404/501）。接入后这里会显示每把 key 的池别、状态与用量（key 值本身不显示）。
        </p>
        <p v-else-if="keysState === 'error'" class="text-xs text-danger">{{ keysMessage }}</p>
        <div v-else-if="keyRows.length" class="overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr class="border-b border-surface-border text-left text-ink-muted">
                <th class="py-2 pr-3 font-medium">标识</th>
                <th class="py-2 pr-3 font-medium">池别</th>
                <th class="py-2 pr-3 font-medium">状态</th>
                <th class="py-2 pr-3 font-medium">用量</th>
                <th class="py-2 font-medium">最近使用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in keyRows" :key="i" class="border-b border-surface-border/60 text-ink-body">
                <td class="py-2 pr-3 font-mono">{{ maskId(row.key_id || row.id || row.name) }}</td>
                <td class="py-2 pr-3">{{ text(row.pool) }}</td>
                <td class="py-2 pr-3">{{ text(row.status) }}</td>
                <td class="py-2 pr-3 tabular-nums">{{ fmt(row.used) }}</td>
                <td class="py-2">{{ timeText(row.last_used_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-xs text-ink-muted">暂无数据。</p>
      </section>

      <!-- 封禁 / 加额 -->
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
          <div class="mb-4 border-b border-surface-border pb-3">
            <h2 class="text-sm font-semibold text-ink-title">封禁 / 解封</h2>
            <p class="mt-0.5 text-xs text-ink-muted">POST /api/v1/admin/accounts/:id/ban</p>
          </div>
          <form class="space-y-3" @submit.prevent="submitBan(true)">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-ink-sub">账号 ID</span>
              <input
                v-model.trim="banForm.account_id"
                type="text"
                required
                autocomplete="off"
                class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 font-mono text-xs text-ink-body focus:border-primary focus:outline-none"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-ink-sub">原因（写入审计日志）</span>
              <input
                v-model.trim="banForm.reason"
                type="text"
                autocomplete="off"
                class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 text-xs text-ink-body focus:border-primary focus:outline-none"
              />
            </label>
            <div class="flex items-center gap-2">
              <button
                type="submit"
                :disabled="banBusy"
                class="rounded-lg bg-danger px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
              >
                封禁账号
              </button>
              <button
                type="button"
                :disabled="banBusy"
                class="rounded-lg border border-surface-border bg-surface px-4 py-2 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title disabled:pointer-events-none disabled:opacity-40"
                @click="submitBan(false)"
              >
                解除封禁
              </button>
            </div>
            <p v-if="banMessage" class="text-xs" :class="banMessageTone">{{ banMessage }}</p>
          </form>
        </section>

        <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
          <div class="mb-4 border-b border-surface-border pb-3">
            <h2 class="text-sm font-semibold text-ink-title">配额调整</h2>
            <p class="mt-0.5 text-xs text-ink-muted">POST /api/v1/admin/accounts/:id/quota</p>
          </div>
          <form class="space-y-3" @submit.prevent="submitQuota">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-ink-sub">账号 ID</span>
              <input
                v-model.trim="quotaForm.account_id"
                type="text"
                required
                autocomplete="off"
                class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 font-mono text-xs text-ink-body focus:border-primary focus:outline-none"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-ink-sub">增减额度（正数加额，负数扣减）</span>
              <input
                v-model.number="quotaForm.delta"
                type="number"
                step="1"
                class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 text-xs text-ink-body focus:border-primary focus:outline-none"
              />
            </label>
            <label class="flex items-center gap-2 text-xs text-ink-sub">
              <input v-model="quotaForm.reset" type="checkbox" class="h-3.5 w-3.5 rounded border-surface-border text-primary focus:ring-primary" />
              <span>改为重置当前窗口（忽略上面的增减值）</span>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-ink-sub">原因（写入审计日志）</span>
              <input
                v-model.trim="quotaForm.reason"
                type="text"
                autocomplete="off"
                class="w-full rounded-lg border border-surface-border bg-canvas-subtle/60 px-3 py-2 text-xs text-ink-body focus:border-primary focus:outline-none"
              />
            </label>
            <button
              type="submit"
              :disabled="quotaBusy"
              class="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            >
              提交调整
            </button>
            <p v-if="quotaMessage" class="text-xs" :class="quotaMessageTone">{{ quotaMessage }}</p>
          </form>
        </section>
      </div>

      <!-- 审计日志（GET /api/v1/admin/audit，已实现但需 ADMIN_API_KEY） -->
      <!-- 摄取历史（M4·W4）：数据由 GitHub Actions 在摄取结束后上报，Worker 代笔写 D1 -->
      <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-surface-border pb-3">
          <div>
            <h2 class="text-sm font-semibold text-ink-title">摄取历史</h2>
            <p class="mt-0.5 text-xs text-ink-muted">
              GET /api/v1/admin/ingest/runs?limit=10 · 由 GitHub Actions 摄取收尾时上报（最近 10 条）
            </p>
          </div>
          <div class="flex items-center gap-2">
            <StatusBadge :state="ingestState" />
            <button
              type="button"
              class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
              @click="loadIngestRuns"
            >
              刷新
            </button>
          </div>
        </div>

        <p v-if="ingestState === 'loading'" class="text-xs text-ink-muted">加载中…</p>
        <p v-else-if="ingestState === 'unimplemented'" class="text-xs leading-relaxed text-ink-sub">
          接口未实现（后端返回 404/501）。
        </p>
        <p v-else-if="ingestState === 'error'" class="text-xs text-danger">{{ ingestMessage }}</p>
        <div v-else-if="ingestRows.length" class="overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr class="border-b border-surface-border text-left text-ink-muted">
                <th class="py-2 pr-3 font-medium">知识库</th>
                <th class="py-2 pr-3 font-medium">状态</th>
                <th class="py-2 pr-3 font-medium">变动文件</th>
                <th class="py-2 pr-3 font-medium">写入 chunk</th>
                <th class="py-2 font-medium">完成时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in ingestRows" :key="i" class="border-b border-surface-border/60 text-ink-body">
                <td class="py-2 pr-3">{{ text(row.wiki_id) }}</td>
                <td class="py-2 pr-3">
                  <span
                    class="rounded px-1.5 py-0.5 text-[11px] font-medium"
                    :class="ingestStatusClass(row.status)"
                  >{{ ingestStatusText(row.status) }}</span>
                </td>
                <td class="py-2 pr-3 tabular-nums">{{ fmt(row.files_updated) }}</td>
                <td class="py-2 pr-3 tabular-nums">{{ fmt(row.points_upserted) }}</td>
                <td class="py-2">{{ timeText(row.finished_at) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="ingestRows.some((r) => r.error)" class="mt-3 text-[11px] leading-relaxed text-danger">
            有失败记录：{{ ingestRows.find((r) => r.error)?.error }}
          </p>
        </div>
        <p v-else class="text-xs text-ink-muted">暂无摄取记录。</p>
      </section>

      <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-surface-border pb-3">
          <div>
            <h2 class="text-sm font-semibold text-ink-title">审计日志</h2>
            <p class="mt-0.5 text-xs text-ink-muted">GET /api/v1/admin/audit · 封禁 / 加额 / 改配置 / 上架 key 的留痕</p>
          </div>
          <div class="flex items-center gap-2">
            <StatusBadge :state="auditState" />
            <button
              type="button"
              class="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-sub transition-colors hover:border-surface-border-hover hover:text-ink-title"
              @click="loadAudit"
            >
              刷新
            </button>
          </div>
        </div>

        <p v-if="auditState === 'loading'" class="text-xs text-ink-muted">加载中…</p>
        <p v-else-if="auditState === 'unimplemented'" class="text-xs leading-relaxed text-ink-sub">
          接口未实现（后端返回 404/501）。
        </p>
        <p v-else-if="auditState === 'error'" class="text-xs text-danger">{{ auditMessage }}</p>
        <div v-else-if="auditRows.length" class="overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr class="border-b border-surface-border text-left text-ink-muted">
                <th class="py-2 pr-3 font-medium">时间</th>
                <th class="py-2 pr-3 font-medium">操作</th>
                <th class="py-2 pr-3 font-medium">执行者</th>
                <th class="py-2 pr-3 font-medium">对象</th>
                <th class="py-2 font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in auditRows" :key="i" class="border-b border-surface-border/60 text-ink-body">
                <td class="whitespace-nowrap py-2 pr-3">{{ timeText(row.at ?? row.created_at ?? row.ts) }}</td>
                <td class="py-2 pr-3">{{ text(row.action) }}</td>
                <td class="py-2 pr-3 font-mono">{{ maskId(row.actor_id ?? row.actorId) }}</td>
                <td class="py-2 pr-3 font-mono">{{ maskId(row.target_id ?? row.targetId ?? row.target) }}</td>
                <td class="py-2">{{ text(row.detail) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-xs text-ink-muted">暂无记录。</p>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue"
import { useApi, isUnimplemented, type AdminIngestRun, type AdminRateLimitResponse } from "~/composables/useApi"
import { useToast } from "~/composables/useToast"

useHead({ title: "管理后台 · TransHelper Prism" })

type LoadState = "idle" | "loading" | "ok" | "unimplemented" | "error"

const { adminUsage, adminRatelimit, adminKeys, adminIngestRuns, adminAudit, adminBan, adminQuota } = useApi()
const { pushToast } = useToast()
const { isLoggedIn, isAdmin, user, loadMe, init } = useAuth()

const usageState = ref<LoadState>("idle")
const usageMessage = ref("")
const usageData = ref<Record<string, unknown> | null>(null)
const keysState = ref<LoadState>("idle")
const keysMessage = ref("")
const keysData = ref<Record<string, unknown> | null>(null)
const ingestState = ref<LoadState>("idle")
const ingestMessage = ref("")
const ingestRows = ref<AdminIngestRun[]>([])
const auditState = ref<LoadState>("idle")
const auditMessage = ref("")
const auditRows = ref<Record<string, unknown>[]>([])

const banForm = reactive({ account_id: "", reason: "" })
const banBusy = ref(false)
const banMessage = ref("")
const banMessageTone = ref("text-ink-muted")

const quotaForm = reactive<{ account_id: string; delta: number; reset: boolean; reason: string }>({ account_id: "", delta: 0, reset: false, reason: "" })
const quotaBusy = ref(false)
const quotaMessage = ref("")
const quotaMessageTone = ref("text-ink-muted")

interface UsageRow {
  account_id: string
  used: string
  remaining: string
  requests: string
}

const usageRows = computed<UsageRow[]>(() => {
  const data = usageData.value
  if (!data) return []
  const list = (Array.isArray(data.items) ? data.items : Array.isArray(data.accounts) ? data.accounts : []) as Record<string, unknown>[]
  return list.map((row) => ({
    account_id: String(row.account_id ?? row.id ?? ""),
    // 后端 T3.2 起用百分比口径；未定稿字段缺失时回落原始数值，再缺则显示「—」
    used: metric(row.used_pct, row.used_cost ?? row.used),
    remaining: metric(row.remaining_pct, row.remaining ?? row.remaining_cost),
    requests: metric(undefined, row.requests ?? row.request_count),
  }))
})

const usageRaw = computed(() => (usageData.value ? safeJson(usageData.value) : ""))

// ── 分档限流观测（GET /api/v1/admin/ratelimit，plan-ratelimit.md §10 R5）──
const ratelimitState = ref<LoadState>("idle")
const ratelimitMessage = ref("")
const ratelimitData = ref<AdminRateLimitResponse | null>(null)

/** 档位中文名（与后端 src/tiers.ts 的 Tier 一一对应） */
const TIER_TEXT: Record<string, string> = {
  logged_in: "已登录用户",
  cn_residential: "境内家庭宽带",
  cn_other: "境内其它网络",
  cn_idc: "境内机房网络",
  overseas: "境外",
  unknown: "未识别网络",
}

/** 整数展示（桶数/计数：后端保证是整数；脏值一律回落「—」） */
function intText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return "—"
  return String(Math.trunc(n))
}

const ratelimitTierRows = computed(() => {
  const list = ratelimitData.value?.tiers
  if (!Array.isArray(list)) return []
  return list.map((row) => ({
    tier: text(row.tier),
    label: TIER_TEXT[text(row.tier)] ?? text(row.tier),
    buckets: intText(row.buckets),
    counted: intText(row.counted),
    // limit=null 表示非标准档位名（后端不编造限额）→ 显示「—」
    limit: row.limit === null || row.limit === undefined ? "—" : intText(row.limit),
  }))
})

const ratelimitScopeRows = computed(() => {
  const scopes = ratelimitData.value?.scopes
  const labels: Array<{ key: string; label: string }> = [
    { key: "search", label: "搜索（按 IP 分档）" },
    { key: "llm", label: "LLM 伴读 / 追问" },
    { key: "burst", label: "突发（10 秒窗口）" },
    { key: "global", label: "全局匿名熔断（当前窗口）" },
  ]
  return labels.map(({ key, label }) => {
    const agg = (scopes?.[key] ?? {}) as { buckets?: unknown; counted?: unknown }
    return { key, label, buckets: intText(agg.buckets), counted: intText(agg.counted) }
  })
})

const ratelimitWindowSec = computed(() => intText(ratelimitData.value?.window_sec))
const ratelimitBlocked = computed(() => intText(ratelimitData.value?.blocked_buckets))
const ratelimitGlobalCount = computed(() => intText(ratelimitData.value?.global?.count))
const ratelimitGlobalSoft = computed(() => intText(ratelimitData.value?.global?.soft))
const ratelimitGlobalHard = computed(() => intText(ratelimitData.value?.global?.hard))

const ratelimitGlobalText = computed(() => {
  const state = ratelimitData.value?.global?.state
  if (state === "hard") return "硬熔断（匿名一律 429）"
  if (state === "soft") return "软熔断（匿名仅关键词回退）"
  if (state === "normal") return "正常"
  return "—"
})

const ratelimitGlobalTone = computed(() => {
  const state = ratelimitData.value?.global?.state
  if (state === "hard") return "text-danger"
  if (state === "soft") return "text-amber-600 dark:text-amber-400"
  return "text-ink-title"
})

/**
 * 可用 key 不足 2 把的池（plan.md §8.4：`configured < 2` 就提示补货）。
 * 纯前端判断，数据来自 `/admin/keys` 的 `pools[].configured`（后端从 env secrets 推导，不依赖 D1）。
 */
const understockedPools = computed<Array<{ pool: string; configured: number }>>(() => {
  const pools = keysData.value?.pools
  if (!Array.isArray(pools)) return []
  return pools
    .map((p) => ({ pool: String((p as Record<string, unknown>)?.pool ?? "?"), configured: Number((p as Record<string, unknown>)?.configured ?? 0) }))
    .filter((p) => Number.isFinite(p.configured) && p.configured < 2)
})

const keyRows = computed<Record<string, unknown>[]>(() => {
  const data = keysData.value
  if (!data) return []
  const list = Array.isArray(data.keys) ? data.keys : Array.isArray(data.items) ? data.items : []
  return list as Record<string, unknown>[]
})

/** 任何后端字段进入渲染前都过滤敏感键，避免 key 明文出现在页面上 */
function safeJson(value: unknown): string {
  const cleaned = stripSensitive(value)
  try {
    return JSON.stringify(cleaned, null, 2)
  } catch {
    return ""
  }
}

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/key|secret|token|password|credential/i.test(k)) continue
      out[k] = stripSensitive(v)
    }
    return out
  }
  return value
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""))
  return Number.isFinite(n) ? n : 0
}

/** 优先展示百分比字段，其次原始数值；两者都没有时显示「—」 */
function metric(pctValue: unknown, rawValue: unknown): string {
  if (typeof pctValue === "number" && Number.isFinite(pctValue)) return `${pctValue.toFixed(1)}%`
  if (rawValue === undefined || rawValue === null || rawValue === "") return "—"
  const n = num(rawValue)
  return Number.isFinite(n) ? fmt(n) : "—"
}

function fmt(value: unknown): string {
  const n = num(value)
  const abs = Math.abs(n)
  if (abs >= 1000) return n.toFixed(0)
  if (abs >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  return String(value)
}

function maskId(value: unknown): string {
  const id = String(value ?? "")
  if (!id) return "—"
  if (id.length <= 8) return `${id.slice(0, 2)}…`
  return `${id.slice(0, 6)}…${id.slice(-3)}`
}

function timeText(value: unknown): string {
  const n = num(value)
  if (!n) return "—"
  const ms = n < 1e12 ? n * 1000 : n
  return new Date(ms).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })
}

async function loadUsage() {
  usageState.value = "loading"
  usageMessage.value = ""
  try {
    usageData.value = await adminUsage()
    usageState.value = "ok"
  } catch (err: unknown) {
    usageData.value = null
    if (isUnimplemented(err)) usageState.value = "unimplemented"
    else {
      usageState.value = "error"
      usageMessage.value = (err as Error)?.message || "加载失败"
    }
  }
}

/** 限流观测：与用量块同一套「独立探测」模式（404/501 → 接口未实现；401/403 → 需运维 key） */
async function loadRatelimit() {
  ratelimitState.value = "loading"
  ratelimitMessage.value = ""
  try {
    ratelimitData.value = await adminRatelimit()
    ratelimitState.value = "ok"
  } catch (err: unknown) {
    ratelimitData.value = null
    if (isUnimplemented(err)) ratelimitState.value = "unimplemented"
    else {
      ratelimitState.value = "error"
      ratelimitMessage.value = adminErrorText(err)
    }
  }
}

async function loadKeys() {
  keysState.value = "loading"
  keysMessage.value = ""
  try {
    keysData.value = await adminKeys()
    keysState.value = "ok"
  } catch (err: unknown) {
    keysData.value = null
    if (isUnimplemented(err)) keysState.value = "unimplemented"
    else {
      keysState.value = "error"
      keysMessage.value = (err as Error)?.message || "加载失败"
    }
  }
}

async function loadIngestRuns() {
  ingestState.value = "loading"
  ingestMessage.value = ""
  try {
    const data = await adminIngestRuns(10)
    ingestRows.value = Array.isArray(data.runs) ? data.runs : []
    ingestState.value = "ok"
  } catch (err: unknown) {
    ingestRows.value = []
    if (isUnimplemented(err)) ingestState.value = "unimplemented"
    else {
      ingestState.value = "error"
      ingestMessage.value = adminErrorText(err)
    }
  }
}

/** 摄取状态的中文与配色：success 绿 / failed 红 / 其它（started、skipped）中性 */
function ingestStatusText(status: unknown): string {
  const s = String(status ?? "")
  if (s === "success") return "成功"
  if (s === "failed") return "失败"
  if (s === "skipped") return "无变更"
  if (s === "started") return "进行中"
  return s || "—"
}

function ingestStatusClass(status: unknown): string {
  const s = String(status ?? "")
  if (s === "success") return "bg-primary-subtle text-primary"
  if (s === "failed") return "bg-danger-subtle text-danger"
  return "bg-canvas-subtle text-ink-muted"
}

/** 管理接口是服务端 ADMIN_API_KEY 保护的运维接口：401/403 说明浏览器会话无权调用 */
function adminErrorText(err: unknown): string {
  const status = (err as { status?: number })?.status
  if (isUnimplemented(err)) return "接口未实现（后端返回 404/501）"
  if (status === 401 || status === 403) return "需要服务端 ADMIN_API_KEY（运维接口），浏览器会话无权调用"
  if (status === 503) return "服务端未配置 ADMIN_API_KEY / 数据库不可用"
  return `操作失败：${(err as Error)?.message || "未知错误"}`
}

async function submitBan(banned = true) {
  if (banBusy.value) return
  if (!banForm.account_id) {
    pushToast("请填写账号 ID", "warning")
    return
  }
  banBusy.value = true
  banMessage.value = ""
  try {
    await adminBan({ account_id: banForm.account_id, banned, reason: banForm.reason || undefined })
    banMessage.value = banned ? "已提交封禁" : "已提交解封"
    banMessageTone.value = "text-primary"
    void loadAudit()
  } catch (err: unknown) {
    banMessage.value = adminErrorText(err)
    banMessageTone.value = "text-danger"
  } finally {
    banBusy.value = false
  }
}

async function submitQuota() {
  if (quotaBusy.value) return
  if (!quotaForm.account_id) {
    pushToast("请填写账号 ID", "warning")
    return
  }
  quotaBusy.value = true
  quotaMessage.value = ""
  try {
    await adminQuota({
      account_id: quotaForm.account_id,
      delta: Number(quotaForm.delta) || 0,
      reset: quotaForm.reset,
      reason: quotaForm.reason || undefined,
    })
    quotaMessage.value = quotaForm.reset ? "已提交重置当前窗口" : "已提交额度调整"
    quotaMessageTone.value = "text-primary"
    void loadAudit()
  } catch (err: unknown) {
    quotaMessage.value = adminErrorText(err)
    quotaMessageTone.value = "text-danger"
  } finally {
    quotaBusy.value = false
  }
}

async function loadAudit() {
  auditState.value = "loading"
  auditMessage.value = ""
  try {
    const res = await adminAudit(30)
    const rows = Array.isArray(res.rows) ? (res.rows as Record<string, unknown>[]) : []
    auditRows.value = rows
    auditState.value = "ok"
  } catch (err: unknown) {
    auditRows.value = []
    if (isUnimplemented(err)) auditState.value = "unimplemented"
    else {
      auditState.value = "error"
      auditMessage.value = adminErrorText(err)
    }
  }
}

onMounted(async () => {
  // init()：页面 onMounted 早于 app.vue，先同步 localStorage 里的会话
  init()
  if (isLoggedIn.value && !user.value) await loadMe()
  if (isAdmin.value) {
    void loadUsage()
    void loadRatelimit()
    void loadKeys()
    void loadIngestRuns()
    void loadAudit()
  }
})
</script>
