<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- TransHelper Prism — 关于页（/about，plan-m4.md W5）
     - 对外说明：定位、数据来源、工作原理、**AI 免责**、隐私、配额与限流、开源致谢、反馈渠道
     - 隐私与免责的每一句都必须与代码实际行为一致（改动代码时请同步本页） -->
<template>
  <div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
    <header class="mb-8 flex flex-col">
      <BackButton class="mb-5 self-start" />
      <h1 class="text-2xl font-bold tracking-tight text-ink-title sm:text-3xl">关于 TransHelper Prism</h1>
      <p class="mt-2 text-sm leading-relaxed text-ink-sub">
        面向中文跨性别与性别多元社群 wiki 的语义检索与 AI 伴读工具。开源、免费、无广告。
      </p>
    </header>

    <!-- AI 免责：放最前面，不藏在页脚 -->
    <section
      class="mb-8 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-relaxed text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100"
      aria-labelledby="disclaimer-title"
    >
      <h2 id="disclaimer-title" class="mb-2 text-sm font-semibold">⚠️ AI 回答不是医疗建议</h2>
      <ul class="list-disc space-y-1.5 pl-5">
        <li><strong>AI 回答由模型生成，可能出错、可能过时。</strong>它与本站检索到的原文片段一起展示，请以片段原文与专业医生判断为准。</li>
        <li>涉及<strong>用药、剂量、检查、手术</strong>等决定时，请咨询有资质的医生；本工具不能替代就诊。</li>
        <li>AI 只依据本次检索到的 wiki 片段作答，并按 <span class="font-medium">[来源n]</span> 标注出处 —— 那些标注<strong>可以点击回跳原文</strong>，建议养成核对原文的习惯。</li>
        <li>如遇紧急或危险情况，请立即就医或联系当地急救服务。</li>
      </ul>
    </section>

    <!-- 数据来源 -->
    <section class="mb-8 rounded-2xl border border-surface-border bg-surface p-5 shadow-card">
      <h2 class="mb-3 text-base font-semibold text-ink-title">内容来自哪里</h2>
      <p class="mb-3 text-sm leading-relaxed text-ink-body">
        本站<strong>不生产内容</strong>，只对下列开源 wiki 做索引与检索，回答里的引用都指回它们的原文：
      </p>
      <ul class="space-y-2 text-sm">
        <li v-for="wiki in wikis" :key="wiki.name" class="flex flex-wrap items-baseline gap-x-2">
          <a
            :href="wiki.url"
            target="_blank"
            rel="noopener noreferrer"
            class="font-medium text-primary hover:underline"
          >{{ wiki.name }}</a>
          <span class="text-xs text-ink-muted">{{ wiki.desc }}</span>
        </li>
      </ul>
      <p class="mt-3 text-xs leading-relaxed text-ink-muted">
        这些 wiki 各有自己的作者与许可，内容与更新归他们所有；本站每日同步一次（UTC 02:00），只重新索引有变化的文件。
      </p>
    </section>

    <!-- 怎么工作 -->
    <section class="mb-8 rounded-2xl border border-surface-border bg-surface p-5 shadow-card">
      <h2 class="mb-3 text-base font-semibold text-ink-title">它是怎么工作的</h2>
      <ol class="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink-body">
        <li><strong>向量检索</strong>：用 <code class="rounded bg-canvas-subtle px-1">BAAI/bge-m3</code> 把查询与文档片段编码成向量，在 Qdrant 里找语义相近的片段（中文、长文本都适用）。</li>
        <li><strong>重排</strong>：对候选片段用 <code class="rounded bg-canvas-subtle px-1">BAAI/bge-reranker-v2-m3</code> 重新打分，把最相关的排到前面（默认开启，可在搜索面板关闭以换取更快响应）。</li>
        <li><strong>AI 伴读</strong>：把命中的片段交给 <code class="rounded bg-canvas-subtle px-1">Qwen3.5-4B</code>，要求它<strong>只依据给定片段</strong>作答、逐条标注 <span class="font-medium">[来源n]</span>，并支持最多 10 轮追问。</li>
        <li><strong>降级兜底</strong>：AI 或向量服务不可用时，会自动退回关键词检索，搜索本身不会因此不可用。</li>
      </ol>
    </section>

    <!-- 隐私 -->
    <section class="mb-8 rounded-2xl border border-surface-border bg-surface p-5 shadow-card">
      <h2 class="mb-3 text-base font-semibold text-ink-title">隐私：我们存什么、不存什么</h2>

      <h3 class="mb-1.5 mt-4 text-sm font-medium text-ink-title">登录（可选）</h3>
      <ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-body">
        <li>使用 X 账号登录时，只读取<strong>账号 id 与用户名</strong>；数据库里<strong>只保存 id 的 SHA-256 摘要</strong>，用户名不落库（只存在于你浏览器里的登录凭据中）。</li>
        <li><strong>不要求实名、不收集手机号，也不收集邮箱。</strong></li>
        <li><strong>不读取、不保存</strong>你的任何帖子、关注关系或其他 X 数据。</li>
        <li>不登录也能正常搜索（只是额度不同、且用不了 AI 伴读）。</li>
      </ul>

      <h3 class="mb-1.5 mt-4 text-sm font-medium text-ink-title">检索与使用数据</h3>
      <ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-body">
        <li><strong>查询词不写入数据库。</strong>但为了提速与省钱，相同的查询结果会在服务端缓存约 <strong>1 小时</strong>（缓存只按"查询词+库+条数"生成，<strong>不与你的账号关联</strong>），到期即消失。</li>
        <li><strong>防滥用计数按 IP 分档</strong>，但存的是<strong>不可逆的 HMAC 摘要</strong>（不是明文 IP），并且只在当前计数窗口内有意义，过期即失效。</li>
        <li>使用 AI 追问时，<strong>该会话的内容</strong>（你的问题、AI 回答、命中片段摘要）会保存下来，用于维持多轮上下文（每会话上限 10 轮）。</li>
        <li>管理员对账号的操作（封禁、加额、上下架服务端密钥等）会留下<strong>审计日志</strong>，其中<strong>不包含</strong>你的检索内容。</li>
        <li>需要删除账号及相关数据时，请通过下方反馈渠道联系。</li>
      </ul>

      <h3 class="mb-1.5 mt-4 text-sm font-medium text-ink-title">我们不做的事</h3>
      <ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-body">
        <li>不出售、不共享你的数据给第三方；无广告、无追踪脚本、无第三方统计 SDK。</li>
        <li>不建立个人画像，不记录你在站内的浏览路径。</li>
      </ul>
    </section>

    <!-- 配额与限流 -->
    <section class="mb-8 rounded-2xl border border-surface-border bg-surface p-5 shadow-card">
      <h2 class="mb-3 text-base font-semibold text-ink-title">额度与限流</h2>
      <ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-body">
        <li>登录用户采用<strong>滚动 5 小时窗口</strong>的额度：纯检索消耗较少，开启重排稍多，AI 按真实 token 计，降级回退不消耗额度。</li>
        <li>界面上<strong>只显示剩余百分比</strong>；重置时刻按你的注册时间锚定，<strong>固定不变</strong>（例如每 5 小时在固定分钟点重置），设置页可以看到具体时刻。</li>
        <li>为防滥用，匿名访问按来源网络分档限速（大陆家庭宽带较宽、机房与境外较严），AI 请求的限额更紧。</li>
        <li>短时间内集中提交（例如 10 秒内 20 次）会被<strong>临时限制约 1 分钟</strong> —— 被限制时页面会给出倒计时，等一会儿即可，不要连续点击。</li>
        <li>AI 伴读需要登录：模型调用成本很高，登录 + 额度是把它对所有人长期开着的唯一办法。</li>
      </ul>
    </section>

    <!-- 开业酬宾（plan-promo.md §5.8）：模型、期限、额度、用完即止、数据边界、速度预期 —— 逐条如实写 -->
    <section class="mb-8 rounded-2xl border border-border-subtle bg-surface p-5 shadow-card">
      <h2 class="mb-3 text-base font-semibold text-ink-title">开业酬宾：限时 DeepSeek V4.1 Flash</h2>
      <ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-body">
        <li><strong>限时</strong>：登录用户的 AI 总结与追问默认使用 <span class="font-mono text-xs">deepseek-flash</span>（DeepSeek V4.1 Flash），无需任何设置。</li>
        <li><strong>额度用完即止</strong>：酬宾由我们自费承担，预算花完（或到期）就<strong>自动结束</strong> —— 届时会切回标准模型（Qwen3.5-4B），<strong>检索与 AI 都不会失败</strong>，页面上会明确提示"已切回标准模型"。</li>
        <li><strong>额度已提升</strong>：酬宾期间登录用户的 5 小时额度窗口提升到约 <strong>4 倍</strong>（≈100 万加权 token）；结束后自动回到标准额度。重置时刻的口径不变。</li>
        <li><strong>「深度思考」</strong>：可以显式开启（默认关闭）。开启后模型会先做内部推理再作答，<strong>更深入但更慢</strong>（实测 12–26 秒，关闭时 7–18 秒），也更费额度。</li>
        <li><strong>该模型较慢</strong>：酬宾模型比标准模型明显更慢；如果你在赶时间，把「深度思考」关掉、或直接使用标准模型链路（不登录时的默认就是标准链路）。</li>
        <li><strong>数据边界不变</strong>：和标准模型完全一样 —— 只把<strong>本次命中的原文片段</strong>与你的问题发给模型服务商，不发完整语料、不发账号信息；AI 输出仅供参考，不能替代医生建议。</li>
        <li>酬宾是给登录用户的（匿名请求不会走酬宾模型）；这既是产品取舍，也是防滥用的一道闸。</li>
      </ul>
    </section>

    <!-- 开源与致谢 -->
    <section class="mb-8 rounded-2xl border border-surface-border bg-surface p-5 shadow-card">
      <h2 class="mb-3 text-base font-semibold text-ink-title">开源与致谢</h2>
      <ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-body">
        <li>本站代码以 <strong>GPL-3.0-or-later</strong> 开源：
          <a
            href="https://github.com/daanser/Trans_Helper_Prism"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary hover:underline"
          >daanser/Trans_Helper_Prism</a>
        </li>
        <li>感谢四个 wiki 的作者、译者与维护者 —— 没有他们的整理，这个工具没有内容可检索。</li>
        <li>运行在 Cloudflare Workers / Pages（计算）、Qdrant Cloud（向量库）、硅基流动（向量、重排与对话模型）之上。</li>
      </ul>
    </section>

    <!-- 反馈 -->
    <section class="rounded-2xl border border-surface-border bg-surface p-5 shadow-card">
      <h2 class="mb-3 text-base font-semibold text-ink-title">问题与反馈</h2>
      <p class="text-sm leading-relaxed text-ink-body">
        检索结果不准、AI 明显说错、页面有问题，或对隐私有疑问，欢迎提
        <a
          href="https://github.com/daanser/Trans_Helper_Prism/issues"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary hover:underline"
        >GitHub Issue</a>。
        反馈检索质量时，请附上你用的<strong>查询词</strong>与期望结果，能大幅加快处理。
      </p>
      <p class="mt-3 text-xs leading-relaxed text-ink-muted">
        提示：若你在网络受限的环境中访问，可能无法完成 X 登录（授权页在 x.com）；此时匿名检索仍然可用。
      </p>
    </section>

    <!-- 底部返回：本页较长，用户反馈"看完要滚回顶部很麻烦"（顶部那个保留不动） -->
    <div class="mt-10 flex justify-center border-t border-surface-border pt-6">
      <BackButton label="返回上一页" />
    </div>
  </div>
</template>

<script setup lang="ts">
import BackButton from "~/components/BackButton.vue"

useHead({
  title: "关于 · TransHelper Prism",
  meta: [
    {
      name: "description",
      content:
        "TransHelper Prism：面向中文跨性别与性别多元社群 wiki 的语义检索与 AI 伴读。开源、免费、无广告；说明数据来源、隐私处理与 AI 免责。",
    },
  ],
})

/** 内容来源（静态列出；不写死文档数，避免过期） */
const wikis = [
  { name: "MtF Wiki", url: "https://mtf.wiki", desc: "跨性别女性相关医疗、生活与社会指南" },
  { name: "FtM Wiki", url: "https://ftm.wiki", desc: "跨性别男性相关医疗、生活与社会指南" },
  { name: "RLE Wiki", url: "https://rle.wiki", desc: "跨性别生活经验与实务（Real Life Experience）" },
  { name: "Mio MtF Wiki", url: "https://mio.chengxi.moe", desc: "社群整理的补充资料" },
]
</script>
