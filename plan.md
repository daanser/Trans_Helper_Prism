# TransHelper Prism — 新项目计划书（plan.md）

> 状态：v0.2（已锁定 2026-09-07：全 Cloudflare Workers + 硅基流动中国站 + Key Pool）
> 背景：旧项目 `transhelper-transsearch` 已 ~2 个月无更新，基本停滞；性能差（reranker 慢、检索链路重、前后端耦合公益模式不可持续）。
> 目标：做一个同定位、更优化的下一代项目，大结构不变（搜索 + Qdrant 向量库 + Embedding + Reranker），但前端重写、后端 ingest / 鉴权 / 配额 / LLM 全面重做。
> 成本决策（已锁定）：不要自部署（服务器比 API 贵）、不用 Google 免费层（RPM 灌不动全量库；GFW 对 Workers 服务端出海无影响但额度不够）、
> 不用 Jina 主力（量不够）。三路（embedding/rerank/LLM）收归**硅基流动中国站一家供应商**，靠闲鱼成品号建 Key Pool 解决实名问题。

---

## 1. 一句话定位

**Prism = 多 wiki 语义搜索引擎 + 可选 LLM 问答**，面向跨性别社群信息检索场景：

- 默认纯检索（快、便宜、配额消耗低）；
- 可选打开 Reranker（精度更高、慢一点）；
- 可选打开 LLM（给总结、可追问聊天、配额消耗大）；
- 用户可自选本次检索的向量库范围（单 wiki / 多 wiki 组合）。

---

## 2. 与旧项目的关系：继承 vs 推翻

| 模块 | 旧项目做法 | 新项目做法 | 说明 |
|---|---|---|---|
| 大结构（检索→重排→回答） | 保留概念 | 继承 | 用户心智不变，降低迁移成本 |
| Qdrant 向量库 | `backend-cf + backend(FastAPI)` 双后端都直连 Qdrant | **只保留一个后端：Cloudflare Workers（Hono，复活 `backend-cf`），Python 版废弃**；Qdrant 本体不动，用 Qdrant Cloud 免费层（两小 wiki 够装，零服务器） | 双后端是维护负担，直接砍掉一个；全 CF 省服务器钱（已锁定 2026-09-07） |
| Embedding | Qwen3-Embedding-0.6B via 硅基流动 | **硅基流动中国站 bge 系列**（一家供应商；免费层 RPM 灌不动全量库，按 token 计费才扛得住；自部署/Google/Jina 均排除） | 接口抽象化，保留切换能力 |
| Reranker | bge-reranker-v2-m3，性能差 | **硅基流动中国站 rerank API**（托管，批量调；用量小，与 embedding/LLM 共用 Key Pool 机制） | 重点优化项之一，见 §5 |
| 前端 | Nuxt3 + 原生旧版双前端 | **重写，单一前端**（见 §4） | 彻底重写，只留一个 |
| 资料入库 | 手动跑 `script/indexer.py` 传资料 | **每天自动爬 GitHub wiki 做增量更新**（见 §7） | 重点优化项之二 |
| 鉴权/公益 | 公益无登录 + Admin Key | **登录制 + 强制绑定邮箱或 X 账号 + 每账号配额**（见 §6） | 防滥用核心 |
| LLM | 仅做查询扩展（query expansion） | **一等功能：总结 + 聊天 + 自定义模型**，模型走**硅基流动中国站 Qwen3-8B**，靠 **Key Pool**（闲鱼成品号 key 池，挂了自动换）解决实名问题（见 §8） | 新增主功能 |
| 搜索选项 | 写死 topK / rerankTopK / 单库 | **每次请求用户可选：向量库范围 / 是否 LLM / 是否 reranker**（见 §3.3） | 产品差异点 |

---

## 3. 产品设计

### 3.1 用户角色

1. **普通用户（登录）**：搜索、看原文引用、可选 LLM 总结/追问。受配额限制。
2. **超额/未登录用户（如果允许）**：只能走**关键词回退**（Qdrant 全文索引，无向量、无 LLM），或直接拒绝服务。二选一，推荐 **"未登录仅关键词回退 + 强登录引导"**，登录后解锁向量检索。
3. **管理员**：看全站用量、封禁账号、管理 wiki 源、配 API Key（硅基流动专用账号）、调默认参数。

### 3.2 核心页面（前端重写后）

- `/` 搜索主页：搜索框 + 三个选项（向量库多选 / LLM 开关 / Reranker 开关）+ 结果列表（标题、来源 wiki、章节路径、分数、原文片段、高亮、可跳转原文）。
- 结果详情 / 追问面板：打开 LLM 时右侧（桌面）/下方（移动）出现"AI 总结 + 追问输入框"，引用来源以卡片形式展示（类似 Perplexity）。
- `/tree` 知识树浏览：按 wiki → 分类 → 章节浏览（旧功能保留，但数据源改为自动同步后的元数据）。
- `/stats`（可精简）：个人剩余额度、检索耗时拆解（向量耗时/rerank耗时/LLM耗时）——对性能优化透明化有好处。
- `/settings`：自定义模型配置（自己的 API Key + base_url + model id）、默认搜索偏好（默认选哪些库、默认开不开 reranker/LLM）。
- `/login`：登录 + 绑定邮箱/X。
- `/about`：许可与致谢（GPL-3.0 继承）。

### 3.3 单次搜索请求参数（草案）

```ts
POST /api/v1/search {
  query: string;                    // 必填
  corpora: ["mtf-wiki"];            // 必填，至少选 1 个；可选值如 mtf-wiki | miomtfwiki；前端多选
  use_reranker: boolean;            // 默认 true（T1.4 压测终定：首条相关率 75%→85%，代价 P50 +66% 仍在 <2s 内，精度优先）
  use_llm: boolean;                 // 默认 false（省配额）
  llm_mode?: "summary" | "chat";    // 首轮 summary，追问 chat
  session_id?: string;              // chat 续聊用
  top_k?: number;                   // 默认 10，上限 30
  model_id?: string | "default";    // LLM 模型选择：默认 Qwen3-8B；或用户自定义模型 id
}
```

返回：

```ts
{
  hits: [{ id, title, url, source /* wiki 名 */, path /* 章节路径 */, snippet, score, rerank_score? }],
  timings: { embed_ms, search_ms, rerank_ms, llm_ms, total_ms },
  quota: { window_start, window_hours, limit_tokens, used_tokens, used_pct, remaining_pct, exceeded },
  answer?: { text, citations: [hit_id], model: "Qwen3-8B" }
}
```

### 3.4 配额语义：滚动 5 小时窗口

**2026-09-09 修订（用户澄清）**：不是「每月 5h」，而是**滚动 5 小时窗口 + 固定额度**，与 ChatGPT / Gemini 的用量窗口同构。

- 窗口：每账号记 `window_start`；当 `now - window_start ≥ window_hours`（默认 **5h**）时**自动开新窗口**（`window_start = now`、`used_tokens = 0`）。
  **不是自然月重置**，从窗口起点算满 5 小时即刷新（滚动窗口）。
- 额度单位：**加权 token**（`limit_tokens` 来自 env `QUOTA_WINDOW_TOKENS`，默认 300,000/窗口）。
- 消耗模型（见 §6.2 权重表）：`used_tokens += 权重`；LLM 按上游真实 `tokens_in + tokens_out` 计。
- **前端只显示百分比**：`used_pct` / `remaining_pct`（0–100，1 位小数）；不显示小时/秒/绝对数。
- 超额后：自动降级为**关键词回退**（Qdrant 全文索引，不调 embedding/reranker/LLM，不耗额度），并明确提示"额度已用尽，已切换为关键词模式"。
- 未登录用户：同样走**回退 + 登录引导**（已决策，不直接拒绝服务）。

---

## 4. 前端：重写方案

### 4.1 结论

- **只保留一个前端**，删掉 `frontend-old` 和双前端包袱。
- 框架二选一（推荐 Nuxt 3 继承，理由：旧 `frontend/` 已是 Nuxt3，团队熟悉；且 SSR 对 SEO/首屏好）：
  - 选项 1：**Nuxt 3 + Vue 3 + Tailwind**（继承旧栈，重写页面与状态管理，复用 `useApi` 思想但重写实现）。
  - 选项 2：Next.js + React（如果主力开发者更熟 React；但迁移成本高，不推荐除非换人）。
- UI 组件库：Tailwind + headless（或 Naive UI / shadcn-vue 二选一，不要手写原生 CSS 重蹈 `frontend-old` 覆辙）。
- 移动端优先：圈子用户手机访问多，搜索页与追问面板必须移动端可用。

### 4.2 前端必须修的旧坑

1. 双前端（Nuxt + 原生）导致功能分叉：新项目只留一个。
2. 管理后台与用户前端混在一起（`config.vue` 混入管理配置）：拆分为 `/settings`（用户）与 `/admin`（管理员），路由级鉴权。
3. 无登录态管理：新加 auth store（access token + refresh，绑定状态，剩余额度轮询/请求头回传）。
4. 无可观测性：每次搜索显示耗时拆解与配额消耗，方便用户理解"开 LLM 很贵"。

---

## 5. 检索链路：Embedding + Qdrant + Reranker 优化

### 5.1 总体链路（可配置开关）

```
query
 ├─ 配额检查（超额 → 关键词回退分支，直接返回）
 ├─ embedding(query) ──→ Qdrant 多 collection 并行检索（dense，可选 hybrid）
 ├─ (可选) RRF 合并（如果上 sparse/BM25 双路；否则单 dense 即可，简化）
 ├─ (可选, use_reranker) rerank(candidates) → 截断 top_k
 └─ (可选, use_llm) LLM summary/chat（引用 hits 作为 context）
```

关键变化：**reranker 与 LLM 都是可选项**，纯向量搜索是最快最省的默认路径。

### 5.2 Reranker：替换与性能优化（旧痛点专项）

旧模型 `bge-reranker-v2-m3` 慢的原因通常是：cross-encoder 对每个 (query, doc) 对逐个推理 + Python 同步串行 + 无 batch + 无缓存 + 模型太大。

新方案（按优先级排序）：

1. **模型与供应商锁定（2026-09-07）**：**硅基流动中国站 rerank API**（bge-reranker 系）。自部署排除（服务器比 API 贵）、Jina/Cohere 免费层排除（量不够/会过期）。
   批量调用 + 候选裁剪照样做，供应商只换不减优化手段。
2. **推理批量化**：candidates 必须 batch 推理（batch=16/32），禁止逐条循环（单次 HTTP 里塞多对，少几次往返；Workers→国内 endpoint 延迟高，batch 更重要）。
3. **候选集裁剪**：向量初排只取 top 30–50 给 reranker，而不是全量；`rerankTopK = ceil(topK×1.5)` 这类旧魔法数字改为配置项并做压测。
4. **可关闭**：`use_reranker=false` 时链路物理跳过 rerank，P50 延迟应 < 800ms（含 embedding）。
5. **Key Pool 共用**：rerank 调用走 §8.5 的 Key Pool（`rerank_pool`，可与 llm_pool 共用一批号，但用量分开记），401/403/429/余额不足自动换 key 重试，池全灭才降级。
6. **缓存**：(query 归一化 + corpora + top_k + 模型版本) 做短期结果缓存；完全相同查询 5 分钟内直接返回（继承旧短期缓存思想，但 key 要带上全部开关参数，避免开/关 reranker 串味）。
7. **超时熔断**：reranker 设置硬超时（如 1.5s），超时自动降级为向量序返回，保证可用性。

性能目标（草案）：

| 路径 | P50 | P95 |
|---|---|---|
| 纯向量（无 rerank，无 LLM） | < 800ms | < 2s |
| 向量 + rerank（top 10） | < 2s | < 5s |
| + LLM 总结（Qwen3-8B 流式首 token） | 首 token < 3s | < 6s |

**M1 压测实测（2026-09-08，`scripts/bench_search.ts`，20 条真实中文 wiki query × 3 轮 × 2 路径，本地 node 直连线上 API）**：

| 路径 | P50 | hit@1 首条相关率 |
|---|---|---|
| 纯向量（无 rerank） | 839ms | 75.0% |
| 向量 + rerank（bge-reranker-v2-m3，batch，top 10） | 1389ms | **85.0%** |

结论（T1.4 终定）：**`use_reranker` 默认开**。rerank 使首条相关率 +10pp（75%→85%），代价 P50 +66%（0.84s→1.39s，仍在 <2s 目标内）；对医疗/社群类 wiki，首条命中质量优先于省这半秒，且 rerank 有超时熔断兜底（§5.2 第 7 条），打开无可用性风险。

### 5.3 Embedding

- 供应商锁定（2026-09-07）：**硅基流动中国站 bge 系列 embedding**，Workers 服务端代调（key 藏 secrets，见 §8.5 Key Pool）。
  排除项：自部署（服务器比 API 贵）、Google AI Studio（免费层 RPM 灌不动全量库）、Jina（量不够）。
- 接口抽象为 `EmbeddingProvider`（TypeScript，活在 Workers 里），以后切供应商只换实现，不动链路。
- 注意事项：多 wiki 分 collection 后，embedding 模型必须全局统一版本；换模型要全量重嵌，提前做版本字段（`embedding_model`, `embedding_dim` 存 collection metadata）。
- 查询 embedding 与文档 embedding 必须同模型同指令（instruction prefix），否则精度崩。
- 全量 ingest 成本：按 token 计费，wiki 体量下是零花钱级；M2 前先拿一个号实测全量 token 数 × 单价再批量买号。

### 5.4 关键词回退（超额/降级分支）

- 触发条件：配额耗尽、embedding/reranker/LLM 上游超时或 5xx、未登录用户。
- 实现（**2026-09-09 修订**）：改用 **Qdrant `payload.text` 全文索引**做关键词回退——查询时按
  `filter: {must:[{key:"text", match:{text: query}}]}` scroll 命中 chunk，本地按 query token 命中度排序、按 path 去重取 top_k。
  - 索引创建：ingest 脚本幂等执行 `PUT /collections/{c}/index {"field_name":"text","field_schema":{"type":"text","tokenizer":"multilingual"}}`
    （`multilingual` 分词对中文可用，已实测「激素」「嗓音」均能命中）。
  - **为什么放弃原「预计算 bigram 索引存 D1」**：实测现有 1481 个 chunk 会产生 **521,925 行** bigram 索引，
    而 D1 免费版每天仅允许写 **100,000 行**（官方 pricing 文档），超 5.2 倍——一次全量写入不可能，且每次重嵌都要重写；
    存储估算也要 149–348 MB（免费单库上限 500 MB）。Qdrant 全文索引零 D1 行、单次请求、与向量检索共用同一个 Qdrant。
- 特点：零 embedding、零配额消耗、延迟低、精度低于向量；返回体带 `fallback: true`，前端 banner 提示。
- `src/bigram.ts` 保留（`splitBigrams` 仍用于本地打分 token 化），但**不再作为回退检索数据源**。

---

## 6. 账号、登录、防滥用、配额

### 6.1 登录与强制绑定

- 登录方式：建议 **OAuth 优先**（X / GitHub / Google 三选一或全上），密码登录可选但增加维护（找回密码、撞库），初期不建议自研密码体系。
- **强制绑定邮箱或 X 账号**：注册后必须完成至少一项绑定才能用向量检索（否则只能关键词回退）。目的：提高批量刷号成本。
  - **已决策（2026-09-07）：X 绑定为主、邮箱为辅。但 TransPrism 主打隐私，引流用户多对隐私敏感，因此必须守住隐私底线**：
    - X OAuth 只取最小必要字段（id + handle，不存头像/粉丝/推文等）；登录页明示"我们只会读取你的 X 账号 id 与用户名，用于防刷号，不读取推文/关注/私信，不会发帖"；提供"绑定后解绑 X、改绑邮箱"的逃生通道（解绑后仍需保留一种有效绑定）。
    - 邮箱绑定作为隐私友好替代项全程可用，不强制用户必须用 X；不做实名、不收集手机号。
    - 所有绑定标识落库时做哈希/最小化存储，日志与管理后台默认脱敏展示（如 `x:****1234`）。
  - 邮箱绑定：发送验证码（需要邮件服务，如 Resend/SES；有成本，需计入预算）。
  - X 绑定：X OAuth，天然一人一号门槛更高。
- 风控：绑定仅 X（邮箱绑定已取消）；异常频率限流（**2026-09-09 落地值：匿名按 IP 10 次/分钟、登录按账号 60 次/分钟**，env 可调；KV 无原子自增，只挡异常频率、不作计费依据）；管理员一键封禁/解封 + 审计留痕。
- 匿名策略（2026-09-09 用户决策）：`REQUIRE_LOGIN=0` —— **匿名也可用完整向量检索**，成本靠限流兜；要改回"匿名仅关键词回退"把该 var 设 `1`。
- 反滥用第二层（CF 边缘限流规则 / Turnstile）**刻意暂缓**：待真的被刷再加。

### 6.2 配额（滚动 5 小时窗口）设计

- 粒度：按账号；**滚动 5 小时窗口**，窗口内累计 `used_tokens`，满 5h 自动开新窗口（见 §3.4，2026-09-09 修订）。
- 额度：`limit_tokens` 来自 env `QUOTA_WINDOW_TOKENS`（默认 300,000/窗口），**不落库**，便于随时调整。
- 消耗模型（权重表，初值，M4 可调）：

| 操作 | 消耗（单位：加权 token） |
|---|---|
| 纯向量搜索 1 次（embed + Qdrant） | 200 |
| + reranker | +100 |
| LLM 总结 / 追问每轮 | 按上游真实 `tokens_in + tokens_out` |
| 关键词回退 | 0 |

- 查询接口每次返回 `quota`：`{ window_start, window_hours, limit_tokens, used_tokens, used_pct, remaining_pct, exceeded }`；
  前端**只显示百分比**，`used_pct ≥ 90` 时提示。
- 存储：复用 D1 `quotas` 表——`period_start` 存 `window_start`、`used_cost` 存 `used_tokens`（零 DDL）；
  扣减走 D1 原子 `UPDATE`（KV 无原子自增，不用 KV 记账）。
- 管理员可手动加/重置当前窗口的额度（运营活动、误杀恢复）。

### 6.3 Auth 技术选型（Workers 版）

- 不拉 Supabase/Clerk（多一供应商多一账单）：Workers 内自研轻量 auth —— OAuth 回调（X 优先，`arctic` 类库）+ `jose` 签 JWT（短 access + refresh）。
  账号 ↔ 绑定 ↔ 配额 ↔ 封禁表全放 D1。不要自研密码体系（无密码登录）。
- 后端鉴权：所有 `/api/v1/search` 必须带 token（未登录走回退分支也需要限流 key：IP+指纹，计数放 KV）。

---

## 7. 数据管线：从"手动传资料"到"每天自动爬 wiki + 增量更新 + 分库"

这是旧项目最"扯淡"的部分，必须重做。

### 7.1 目标

- 每天定时（cron，如 UTC 01:00）从 GitHub 自动拉取各 wiki 仓库最新内容，做增量更新。
- 每个 wiki **单独存**（Qdrant 里一个 wiki = 一个 collection，例如 `mtf_wiki_v1`），前端 `corpora` 参数即 collection 选择器。
- 支持新增 wiki 源时零代码改动（加一行配置即可）。
- 首批 4 个源（锁定 2026-09-07）：MtF-wiki、FtM-wiki、rle-wiki（同属 project-trans）、MioMtFWiki（KitsuMio）。
  Qdrant Cloud 集群在悉尼区（亚太最近，别无选择），Workers 调它走公网，延迟 M1 压测时实测。

### 7.2 Wiki 源配置（草案）

```yaml
# config/wikis.yaml
wikis:
  - id: mtf-wiki            # 前端 corpora 取值，对应 collection mtf_wiki_v1
    name: "MtF Wiki"
    repo: "project-trans/MtF-wiki"
    branch: "main"          # 以实际默认分支为准，ingest 时先探
    content_dir: "content/zh-cn"
    site_url: "https://wiki.transhelper.org/mtf"   # 占位，按实际填
    schedule: "daily"
    chunk: { max_chars: 1200, overlap: 150 }
    enabled: true
  - id: ftm-wiki
    name: "FtM Wiki"
    repo: "project-trans/FtM-wiki"
    branch: "main"
    content_dir: "content/zh-cn"
    site_url: "https://wiki.transhelper.org/ftm"   # 占位
    schedule: "daily"
    chunk: { max_chars: 1200, overlap: 150 }
    enabled: true
  - id: rle-wiki
    name: "RLE Wiki"
    repo: "project-trans/rle-wiki"
    branch: "main"
    content_dir: "content/zh-cn"
    site_url: "https://wiki.transhelper.org/rle"   # 占位
    schedule: "daily"
    chunk: { max_chars: 1200, overlap: 150 }
    enabled: true
  - id: miomtfwiki
    name: "Mio MtF Wiki"
    repo: "KitsuMio/MioMtFWiki"
    branch: "main"
    content_dir: "content/zh-cn"
    site_url: "https://wiki.transhelper.org/mio"   # 占位
    schedule: "daily"
    chunk: { max_chars: 1200, overlap: 150 }
    enabled: true
```

### 7.3 增量更新流程（crawler/indexer）

```
GitHub Actions（每日 UTC 02:00 + 手动触发，见 .github/workflows/ingest.yml）
 ├─ 拉取：GitHub trees API 一次拿到全部 .md 路径 → git blob sha（内容指纹，细到文件级）
 ├─ diff：从 Qdrant 读出每个 path 的 blob_sha（payload.blob_sha）→ 只挑变化文件；消失的文件删点
 ├─ 逐库处理（Node 环境，无 Workers CPU/内存墙）：
 │   ├─ 解析：frontmatter + markdown → 清洗（去 shortcode/HTML 注释/多余空行，继承旧 indexer 逻辑，TS 重写）
 │   ├─ 分块：按标题层级 + 字符窗口 + overlap；每 chunk 记录 {wiki_id, path, title, section, url, commit_sha, chunk_index, updated_at, blob_sha}
 │   ├─ embedding（硅基流动中国站，批量，走 §8.5 embed_pool）→ Qdrant Cloud upsert（point id 幂等）
 │   └─ 删除：文件删除/内容变更 → 按 point id 删旧点后再写新点
 └─ 全量重嵌（换模型时）：建 `{wiki}_v2` collection + 别名切换，旧版保留到验证通过
```

> **为什么不用 Worker Cron + Queues（2026-09-09 修订）**：实测 Cloudflare 免费版 CPU 10ms / 内存 128MB / 单次 50 子请求，
> Worker 内「下载 tarball + gunzip + 全量 embed」必然 `exceededMemory` / `exceededCpu`（`ingest_runs` 从未落过成功记录，
> 所以自动更新一直没生效）。迁到 GitHub Actions（免费、无这些限制）后：首次全量 1481 chunk 约 2 分钟；
> 二次运行 `upserted=0`（真增量生效）。Worker 侧 `wrangler.jsonc` 已移除 crons；
> `/api/v1/admin/ingest/trigger` 保留但仅在升级 Workers Paid 后才有意义。

### 7.4 要点

1. **幂等 point id**：`sha1(wiki_id:path:chunk_index)`，重跑不重复。
2. **删除处理**：旧手动脚本大概率没处理删除；新管线必须处理（文件删除 → 删 points + 删 D1 索引行；chunk 数量变少 → 删多余 index）。
3. **失败重试与告警**：单 wiki 失败不影响其他 wiki（Queue 天然隔离）；失败发通知（邮件/群机器人）；保留上次成功 SHA，下次接着 diff。
4. **回滚**：collection 命名带版本（`_v1`），重嵌/换模型时建 `_v2` + 别名切换，旧版保留到验证通过。
5. **解析复用**：旧 `script/indexer.py` 的 frontmatter 解析、body 清洗、`_index.md` 目录元数据逻辑搬过来，**用 TypeScript 重写**为可测试模块 + 单测（vitest，跑在 Workers 外）。
6. **定时载体**：**GitHub Actions**（免费、无 Workers CPU/内存/子请求墙；2026-09-09 修订，原 Cron Triggers + Queues 方案见 §7.3 说明）。

### 7.5 元数据与知识树

- 每 chunk 存 `title / section_path / url / wiki_id / updated_at`，知识树 API 直接按 `wiki_id + section_path` 聚合，不再需要单独维护树。
- 原文 URL 拼接规则按 wiki 配置 `site_url + path`，保证搜索结果可跳转。

---

## 8. LLM：硅基流动中国站 Qwen3.5-4B + Key Pool + 自定义模型

### 8.1 默认模型（T0.0 实测锁定 2026-09-07）

| 候选 | 延迟（max_tokens=8，本地测） | 结论 |
|---|---|---|
| `Qwen/Qwen3-8B` | 4s / 17s / 19s | 出局：慢到不可用 |
| `Qwen/Qwen3.5-4B` | **0.42s** | ✅ 默认 `model_id="default"` |
| `THUDM/GLM-4-9B-0414` | **0.41s** | ✅ 备选（同级 failover） |
| `THUDM/GLM-Z1-9B-0414` | 15.4s | 出局：推理模型，天生慢 |
| `Qwen/Qwen2.5-7B-Instruct` | 27s | 出局：疑似排队 deprioritized |

- Workers 服务端统一代理调用，前端永不直连，更永不碰 key。
- Key 来自 **Key Pool**（见 §8.5）：闲鱼成品号解决实名问题。**灰产 key 无法轮换（买定离手），按消耗品处理**：
  一次多买几个进池，挂一个自动剔除一个，打到 <2 可用就告警补货；买新号走 `/admin/keys` 热加载（这是"上架"不是"轮换"，旧 key 死了就抛了）。
- 风险：免费/赠金随时可能缩水、单号随时可能死。必须做：**超时 + 换 key/换模型重试 + 降级**（池全灭 → 只返回纯搜索结果 + "AI 总结暂不可用"），以及 §8.2 的自定义模型逃生通道。

### 8.2 自定义模型

- 用户在 `/settings` 填自己的 OpenAI-compatible 配置：`base_url + api_key + model`（存加密，只用于该用户的请求；后端代调，不暴露给他人）。
- 服务端也允许管理员配置多个候选模型（如下游免费额度变化可切），`model_id` 白名单控制。
- 安全：用户 key 加密存储（KMS/环境密钥 + AES-GCM），日志永不打印 key，调用失败不回显 key。

### 8.3 LLM 功能范围

1. **总结（summary）**：基于本次 hits（top_k 全文或截断）做带引用总结，system prompt 强制"只基于给定资料回答，不编造；每条关键结论标注 [来源 n]"。
2. **追问（chat）**：`session_id` 续多轮，上下文 = 限定窗口（最近 N 轮 + 初始 hits），超长截断；**每轮都扣额度**，前端明确提示。
3. **查询扩展（可选）**：旧项目的 query expansion 可以保留为内部选项，但默认关闭（省 LLM 配额）；或只在纯搜索零结果时触发一次。

### 8.4 成本控制（重要：LLM 消耗额度很猛）

- 默认 `use_llm=false`（已决策 2026-09-07：默认关）；打开时前端二次确认"本次将消耗较多额度"。
- 流式输出（SSE），首 token 计时；设置 max_tokens 上限（如 800）与请求超时。
- prompt 长度控制：hits 截断（如每条 ≤600 字，共 ≤6 条），避免 context 爆炸烧钱。
- 每个 chat session 设最大轮数（如 10 轮），超了提示开新会话。

### 8.5 Key Pool（硅基流动中国站 key 池，本节是生命线）

前提判断（2026-09-07）：CF 不可能被硅基流动封 IP（要封就是封一整个 CF 出口段，不现实），所以风险不在网络层，
只在**账号层**（号主找回、余额耗尽、单号被封）。Pool 按"随时会死一个 key"设计：

- 池子至少分两个：`embed_pool`（embedding+ingest 用）与 `llm_pool`（rerank+LLM 用），别把鸡蛋放一个号里。
  号 A 挂了只影响它负责的那路，另一路无感。
- 调用策略：轮询/最少在用优先 → 失败（401/403/429/余额不足/超时）→ 标记该 key 冷却或剔除 → 下一个 key 重试。
  池全灭才降级（LLM 全灭→纯搜索；embedding 全灭→回退分支），并打 `warnings`。
- 每 key 用量记账（D1）：哪个号烧了多少 token，admin 可见，方便判断"这个号快没了，该补货了"。
- 告警线：可用 key < 2 个就通知补货；新 key 上架走 `/admin/keys` 接口热加载，不重新部署。
- 安全：key 只活在 Workers secrets（或 D1 加密字段），日志永不打印 key，报错不回显；前端/仓库永不出现。
- 验货标准（买号时）：有可用余额/赠金、embedding+rerank+LLM 三个接口都调得通。先买 1 个验全链路再批量。
- 逃生通道不变：`EmbeddingProvider`/LLM provider 保持接口抽象，真到"号全灭且买不到"那天，切 Jina/Gemini 改一行配置（§8.2 自定义模型同时是用户的自救通道）。

---

## 9. 后端架构（单后端：Cloudflare 全家桶）

### 9.1 技术选型（已锁定 2026-09-07）

- **API 服务**：Cloudflare Workers + TypeScript + Hono（**复活旧 `backend-cf/`**，在其 `index/qdrant/cache/rate-limit` 基础上重写模块划分；Python `backend/` 废弃）。
- **DB**：D1（SQLite：`accounts` 账号、`bindings` 绑定〔只存 `sha256(x_id)`〕、`quotas` 配额窗口、`provider_keys`/`key_usage` key 用量、`ingest_runs`、`chat_sessions`、`custom_models`、`audit_log`）
  + KV（短期搜索缓存、限流计数、**key 禁用集 `keydeny:<pool>`**、OAuth state）。
  ⚠️ 配额扣减走 D1 原子 `UPDATE`（KV 无原子自增，不能用于记账）；`quotas.period_start`=窗口起点、`used_cost`=已用加权 token（列名沿用，语义已改）。
  （`bigram_index` 表仍在 schema 中，但回退检索已改用 Qdrant 全文索引，见 §5.4。）
- **向量库**：Qdrant（不变），per-wiki collection，用 **Qdrant Cloud 免费层**（两小 wiki 够装；装不下才考虑 Vectorize，不主动迁）。
- **模型调用**：Workers 服务端代调硅基流动中国站（embedding/rerank/LLM），全部走 §8.5 Key Pool。
- **任务调度**：**GitHub Actions**（每日 UTC 02:00，`backend-cf/scripts/ingest-incremental.ts`）；Worker 侧不再注册 Cron。
- **部署**：`wrangler deploy` 一条命令；前端放 Cloudflare Pages（Nuxt，`nitro.preset` 已是 `cloudflare_module`，顺手）。
- **前置实测（M0 第一件事）**：Workers → `api.siliconflow.cn` 连通性 + P50 延迟。不通则全 CF 方案塌，届时回退国内云（届时重估）。

### 9.2 模块划分（草案，TypeScript）

```
backend-cf/
├── src/
│   ├── index.ts            # Hono 入口、路由注册、中间件（复活旧版，瘦身）
│   ├── auth.ts             # OAuth 回调、jose JWT、邮箱/X 绑定、封禁（旧版 auth.ts 扩展）
│   ├── quota.ts            # 配额计量、KV 原子扣减、剩余额查询
│   ├── search.ts           # embedding → qdrant → rerank 编排、开关、可观测 timings
│   ├── embeddings.ts       # EmbeddingProvider + 硅基流动实现（走 embed_pool）
│   ├── rerank.ts           # 批量 rerank（走 llm_pool，超时熔断）
│   ├── llm.ts              # 硅基流动代理、自定义模型、summary/chat、SSE 流式
│   ├── keypool.ts          # §8.5：轮询选 key、失败换 key、用量记账、热加载（新建）
│   ├── fallback.ts         # D1 bigram 索引回退检索（旧 sparse.ts 思想，查表实现）
│   ├── ingest/
│   │   ├── cron.ts         # Cron Trigger 入口：tarball 拉取 + diff + 发 Queue
│   │   ├── consumer.ts     # Queue consumer：解析→分块→embed→upsert→写 runs
│   │   └── parser.ts       # frontmatter 解析 + body 清洗（旧 indexer.py 逻辑，TS 重写）
│   ├── wiki_registry.ts    # wikis.yaml（转 KV/D1 配置，新增 wiki 零代码）
│   └── db/schema.sql       # D1 表结构
└── tests/                  # parser/chunker/quota/keypool 换 key/降级单测（vitest）
```

### 9.3 API（**2026-09-09 已全部实现并上线**，实际形状以此为准）

```
GET  /api/v1/auth/oauth/x/start      # 302 → X 授权页（PKCE）
GET  /api/v1/auth/oauth/x/callback   # 302 → 前端 /login/#token=<JWT>
GET  /api/v1/me                      # 账号 + 配额（quota 为百分比口径）
POST /api/v1/search                  # 非流式；未登录（REQUIRE_LOGIN=0）也可用，仅限流
POST /api/v1/search/stream           # SSE：hits/session/citations/delta/done/error
POST /api/v1/chat                    # 多轮追问（session_id，上限 10 轮）
GET  /api/v1/corpora                 # wiki 列表 + 每库 chunk 数
GET  /api/v1/tree/{wiki_id}          # 知识树
GET  /api/v1/settings/models         # 自带模型列表
POST /api/v1/settings/models         # 保存自带模型（api_key 加密落库）
DEL  /api/v1/settings/models/{id}    # 删除自带模型
GET  /api/v1/admin/usage             # 用量总览（accounts ⟕ quotas 聚合）
GET  /api/v1/admin/keys              # key 池健康（只出 key_ref）
POST /api/v1/admin/keys              # 上架/禁用 key（写 KV 禁用集 + 审计）
GET  /api/v1/admin/audit             # 审计日志
POST /api/v1/admin/accounts/{id}/ban          # 封禁/解封（?unban=1）
POST /api/v1/admin/accounts/{id}/quota        # 加额/重置当前窗口
POST /api/v1/admin/db/apply-schema            # 幂等应用 D1 schema（bootstrap 通道）
POST /api/v1/admin/ingest/trigger             # 手动摄取（仅 Workers Paid 有意义）
POST /api/v1/admin/backfill-urls              # 存量 URL 回填（分页）
# 绑定邮箱：**已取消**（T3.7），绑定仅 X；`/auth/bind/*` 不再提供
```

---

## 10. 非目标（本期不做）

1. 不做自研 embedding/reranker 训练，不做自部署模型推理；只做选型与工程优化。
2. 不做密码登录（除非有强烈需求）；先 OAuth + 绑定。
3. 不做全文爬虫（只爬 GitHub wiki 仓库 markdown，不爬渲染后站点）。
4. 不做多语言（先中文；embedding prompt 与分词都按中文优化）。
5. 不做 Python 后端；单 Workers 后端（旧 `backend/` 废弃）。
6. 不承诺免费额度之外的 SLA；先跑通再谈扩容。

---

## 11. 里程碑（建议 4 阶段）

- **M0 项目骨架（0.5–1 周）**：Workers（Hono，复活 backend-cf）+ Nuxt 重写壳 + Qdrant Cloud 免费层单 collection（mtf-wiki）
  + Key Pool 骨架（embed_pool/llm_pool + 换 key 重试）+ 纯向量搜索跑通 + `corpora/use_reranker/use_llm` 参数占位。
  **M0 第一件事**：Workers → `api.siliconflow.cn` 连通实测，不通则方案塌（届时重估）。
- **M1 检索优化（1–2 周）**：硅基流动 rerank 接入 + 批量化 + 超时熔断、可关闭；KV 短期缓存；timings；压测达 §5 性能目标；D1 bigram 回退分支。
- **M2 数据管线（1 周）**：wiki 注册表 + Cron+Queue 每日增量 + 增量 upsert + 删除处理 + 多 collection（mtf-wiki + miomtfwiki）+ 知识树 + bigram 索引。
- **M3 账号与 LLM（1–2 周）**：X OAuth 登录 + 强制绑定 + 配额（滚动 5 小时窗口 + 加权 token，前端显示百分比）+ 超额回退 + Qwen3.5-4B 总结/追问（走 llm_pool）+ 自定义模型 + SSE 流式 + 管理后台（含 keys 管理）。
- **M4 灰度与运营（持续）**：小圈子内测、key 补货/轮换演练、权重调参、封禁与加额工具、文档与致谢页。

---

## 12. 决策记录（已全部拍板，2026-09-07）

1. 配额：**滚动 5 小时窗口 + 加权 token**（窗口满 5h 自动刷新，非自然月）。
2. 未登录用户：**关键词回退 + 登录引导**（不拒绝服务）。
3. `use_reranker`：**默认开（T1.4 压测终定，2026-09-08）**。实测 20 条真实 query：首条相关率 75%→85%（+10pp），P50 0.84s→1.39s（仍在 <2s 目标内）；精度优先，超时熔断兜底。数据见 §5.2。
4. 前端框架：**Nuxt 3 单前端**（Cloudflare Pages 托管）。
5. 后端：**~~彻底放弃 CF Workers，只留 Python~~ → 反转：全 Cloudflare Workers（复活 backend-cf），Python 版废弃**。理由：省服务器钱；Workers 调硅基流动走 CF 出口，不怕被封 IP。
6. 绑定策略：**X 绑定为主、邮箱为辅，但必须守隐私底线**（最小字段、明示用途、可解绑改绑、落库脱敏；见 §6.1）。邮件服务商未定（Resend/SES 二选一，M3 前定）。
7. 模型供应商：**硅基流动中国站一家全包**（embedding bge + rerank + Qwen3-8B）。排除：自部署（服务器比 API 贵）、
   Google 免费层（RPM 灌不动全量库）、Jina/Cohere 主力（量不够/会过期）。GLM 国际站备选（没用上，Flash 逃生可切）。
8. 实名问题：**闲鱼成品号 + Key Pool**（embed_pool/llm_pool 分池、失败自动换 key、用量记账、<2 可用 key 告警、admin 热加载；见 §8.5）。
9. 沿用 GPL-3.0（防 DMCA；衍生兼容）。
10. 向量库：**Qdrant 不动**，用 Qdrant Cloud 免费层；装不下才考虑 Vectorize。

---

## 13. 成本与风险（先说丑话，v0.2 版）

- **买号 ToS 风险**：闲鱼成品号 + 多号轮换属灰色地带，可能单号被封、连坐、号主找回。缓解就是 §8.5 整套：
  embed/llm 分池隔离、失败自动换 key、用量记账、<2 可用告警、admin 热上架；provider 接口保持抽象，真到"无号可用"那天切备用供应商只改配置。
- **网络层判断**：CF 出口 IP 段不可能被硅基流动封（要封就是误伤整个 CF），风险只在账号层。尽管如此，M0 第一件事仍是 Workers → `api.siliconflow.cn` 实测（连通 + P50），不通则全 CF 方案塌。
- **Qdrant Cloud 免费层**：确认规格装得下两 wiki（chunks × 1024 维）；chunk 参数别切太碎；collection 级统计监控。
- **邮箱验证码成本**：发信要钱；X 绑定为主、邮箱为辅，或初期白名单邀请制降低发信量。
- **滥用**：强制绑定 + 配额 + 限流只能抬高门槛，不能杜绝。管理后台的封禁/加额/keys 管理必须好用。
- **法律与内容**：跨性别议题内容敏感，wiki 源可信度与更新、LLM 幻觉引用必须用"强制引用+不编造" prompt 约束；考虑敏感操作审计日志。

---

## 附：旧代码可复用清单

- `old-Trans-Search/backend-cf/src/*`：**复活**——`index.ts`（Hono 入口骨架）、`qdrant.ts`（Qdrant 操作）、`cache.ts`（短期缓存思想→搬 KV）、
  `rate-limit.ts`（限流思想→搬 KV）、`embedding.ts`/`rerank.ts`（调用形状参考，改走 Key Pool）、`types.ts`（类型定义参考）。
- `old-Trans-Search/script/indexer.py`：frontmatter 解析、`_index.md` 目录元映射、body 清洗正则 → 用 TS 重写为 `ingest/parser.ts` 并补单测。
- `old-Trans-Search/doc/API.md`、`frontend/composables/useApi.ts`：API 形状参考。
- `old-Trans-Search/backend/`（Python）：废弃，不复用。
- `wrangler.jsonc`：部署配置参考。

---

*plan v0.2 已锁定，对应任务清单见 `tasks.md`（M0–M4）。开工顺序：M0 连通实测 → M0 骨架 → M1 → M2 → M3。*
