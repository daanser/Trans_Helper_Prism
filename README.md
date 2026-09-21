# TransHelper Prism

> 跨性别与性少数中文 wiki 的**语义检索 + AI 伴读**：把 MtF Wiki、FtM Wiki、RLE Wiki、Mio MtF Wiki 四部知识库聚合成一个搜索框，
> 向量召回 + 二次重排直达原文，并可按需让模型**只依据命中片段**生成要点总结与多轮追问。
> 全站跑在 Cloudflare（Workers + Pages + D1/KV），向量库用 Qdrant Cloud，模型走硅基流动（**长期免费**）。

[![ingest](https://github.com/daanser/Trans_Helper_Prism/actions/workflows/ingest.yml/badge.svg)](https://github.com/daanser/Trans_Helper_Prism/actions/workflows/ingest.yml)
[![watchdog](https://github.com/daanser/Trans_Helper_Prism/actions/workflows/watchdog.yml/badge.svg)](https://github.com/daanser/Trans_Helper_Prism/actions/workflows/watchdog.yml)

- **线上站点**：<https://search.chengxi.moe>，<https://search.transhelper.org>
- **浏览器访问的一切都在自有域名下**：`/api/*` 由 Pages Function 同源反代到 Worker（`*.workers.dev` 在墙内被拦，仅用于服务端内部调用）
- **使用说明与免责**：<https://search.chengxi.moe/about>
- **许可证**：复合许可 —— 代码 [GPL-3.0-or-later](./LICENSE)，索引数据见 [`LICENSE-DATA.md`](./LICENSE-DATA.md)

---

## 功能

| 能力 | 说明 |
|---|---|
| 四库语义检索 | 一次查询跨 MtF / FtM / RLE / Mio 四部 wiki，可按库勾选（芯片与「高级」同行） |
| 向量 + 重排 | `BAAI/bge-m3`（1024 维）召回 → `BAAI/bge-reranker-v2-m3` 二次重排（可关闭） |
| **返回条数可选** | `top_k` **1–50**（默认 10，前端收在「高级」里）；**未登录上限 5**，超出会夹取并回 `top-k-clamped-anon` |
| 重排过采样 | rerank 取 `min(ceil(3×n), 64)` 条候选再截前 n 条（候选封顶 = rerank 每批 32 条的两批） |
| KV 缓存 | 相同 query + 库 + 条数 **1 小时**内命中缓存，跳过 embedding 与向量检索（`timings.cached=true`） |
| 超时熔断 / 降级 | 上游各自独立超时；单库失败不影响其它库；全挂时自动降级为 **Qdrant 全文索引**（零 embedding，`fallback:true`） |
| AI 伴读 | `Qwen/Qwen3.5-4B`（默认关闭思考链）SSE 流式，**只依据检索片段**并逐条标 `[来源n]`（可点回原文）；多轮追问上限 10 轮 |
| AI 伴读 · 来源白名单 | **Mio MtF Wiki 不参与伴读**（CC BY-ND 4.0 不允许演绎）：跳过其条目后**顺延补齐**到 6 条，引用编号保留原始序号（可能不连续，如 1/3/4/5/6/7）；全部命中都来自 Mio 时不调模型 |
| 账号 | X OAuth 2.0 + PKCE → 无状态 JWT；**DB 只存 `sha256(x_id)`**，不存 X 明文，不收邮箱/手机号 |
| 配额 | **滚动 5 小时窗口 + 加权 token**，窗口**按注册时间网格锚定**（重置时刻固定可预测）；前端只显示百分比 + 「x 小时后重置」 |
| 分档限流 | 按来源分档（见下）；**突发 20 次/10 秒 → 硬封 60 秒**；全局匿名熔断**软 300 / 硬 600** |
| 自带模型 | 用户自配 OpenAI 兼容端点，api_key **AES-GCM 加密落库**，SSRF 校验 |
| 管理端 | 用量总览与**上游调用汇总** / key 池健康与上下架（只出 `key_ref`）/ 摄取历史 / 分档限流观测 / 封禁 / 加额 / 审计 |
| **开业酬宾** | 限时（默认 30 天）让**登录用户**默认使用 DeepSeek V4.1 Flash（`deepseek-flash`，经基元律动）；额度展示 **4×（≈1M/5h）**；可开**深度思考**（默认关）；**按真实 usage 自算成本**，累计达预算（默认 ¥136）自动收闸并**回退免费模型**；一键 KV 关闭 |
| 运维探活 | `watchdog.yml` **每 30 分钟 6 项检查**（含一次真实匿名检索），失败即发邮件 |
| 合规 | `/about` 说明数据来源、隐私处理与**医疗免责**；首次访问弹免责确认（可「以后不再提示」） |

### 分档限流（次/分钟）

| 档位 | 限额 | 说明 |
|---|---|---|
| 登录用户 | 60 | 以账号计 |
| 中国大陆家宽 | 30 | 按 ASN 判定 |
| 中国大陆其它 | 15 | |
| 中国大陆机房 | 6 | 云厂商 ASN |
| 境外 | 10 | |
| 未知 | 5 | |

LLM（AI 伴读）限额 = 对应档位 ÷ `RATE_LIMIT_LLM_DIVISOR`（默认 5）向上取整。
计数落在 D1（`HMAC` 桶，**不存明文 IP**）；全局匿名软熔断触发时匿名降级为关键词回退，硬熔断则 429（登录用户不受影响）。
**这些限制的目的不是省钱，而是防止上游账号被判滥用/封号**（见 `history.md` 坑 45）。

## 架构

```
                        ┌────────────────────────────┐
   浏览器 ──HTTPS─────▶ │ Nuxt3 前端 (Pages)          │  search.chengxi.moe
                        │  + Pages Function /api/* 反代│  search.transhelper.org
                        └──────────────┬─────────────┘
                                       │ 同源 /api/v1/...
                        ┌──────────────▼─────────────┐
                        │ Workers 后端 (Hono, TS)     │  transhelper-prism-backend
                        │ 检索 / 重排 / 缓存 / 降级    │  （workers.dev 仅服务端内部用）
                        │ 限流分档 / 配额 / 鉴权 / 管理 │
                        └───┬──────────┬─────────┬────┘
                            │          │         │
              embed/rerank/chat    向量检索    D1（账号·配额·限流计数·审计）
                            │          │         KV（缓存·禁用集·OAuth state）
                            ▼          ▼
                  ┌──────────────┐  ┌──────────────┐
                  │ 硅基流动 中国站 │  │ Qdrant Cloud │
                  │ bge-m3/rerank │  │ 4 collections│
                  │ Qwen3.5-4B    │  │ + text 索引   │
                  │ （长期免费）    │  └──────▲───────┘
                  └──────────────┘         │ upsert/delete（按 point id）
                        ┌──────────────────┴────────────────────┐
                        │ GitHub Actions                        │
                        │ ① ingest：每日 UTC 02:00 增量摄取       │
                        │ ② watchdog：每 30 分钟探活（6 项）      │
                        └───────────────────────────────────────┘
```

> **为什么摄取不跑在 Worker 里**：免费版限制 CPU 10ms / 内存 128MB / 单次 50 子请求，
> Worker 内下载 tarball + gunzip + 全量 embed 必然 `exceededMemory` / `exceededCpu`（`history.md` 坑 13/14）。
> 摄取在 Actions 里跑，再通过管理端点把结果回报给 Worker 落 D1。

## 技术选型：为什么没有用 Jev

**Jev** 是 TypeSafe AI（前 OpenAI / Google Brain 研究员 Diogo Almeida 创办）于 2026-09-15 发布的
**「System One Model」**：它**不生成文本**，只做**结构化决策** —— 输入一段状态（State）加若干类型化问题，
直接返回选项、评分或布尔概率（Choice / Score / Noul）。公开费率约 **$0.042 / 100 万输入 token**（输出免费），
公开渠道实测 P50 延迟约 0.24 秒，在「答案集合固定、调用量大」的分类与路由环节确实又快又省。

本项目**评估过它，但不采用**：

| 本项目的模型用途 | 为什么不用 Jev |
|---|---|
| **AI 伴读**（要点总结 + 追问） | 需求是**生成自然语言**并逐条标注 `[来源n]`；Jev 不生成文本，能力面不重叠 |
| **重排**（`bge-reranker-v2-m3`） | ① 现方案是**开放权重** cross-encoder，直接给 query–doc 相关性分数、即插即用；改用 Jev 要把候选改写成「类型化问题 + 评分标准」并自定阈值与校准，工程成本换不来收益。② 重排是**每次检索都走**的高频路径，多押一个付费上游不划算 |
| **提示注入拦截**（`src/guard.ts`） | 现在是**正则**：零成本、零网络、**确定性**，且刻意不依赖任何模型的服从性；换成一次模型调用只会更慢、更贵、更不确定 |

还有三条与本项目定位直接冲突：

- **供应商与成本**：embed / rerank / chat 三路刻意收归**硅基流动中国站一家**、用**长期免费**额度（`plan.md` §12 决策 7）。Jev 的免费额度来自 Vercel AI Gateway 的**限时促销**，正式按量计费 —— 引入即多一份账单。
- **数据边界**：本站承诺「只把**本次命中的原文片段**与你的问题发给模型服务商」（见「隐私与合规」）。多一个上游就是多一处数据出境点，而这里的内容涉及医疗与性别议题，能少发一处就少发一处。
- **可复现性**：本项目的开放性建立在**开放权重**之上（`bge-m3` / `bge-reranker-v2-m3` 可自托管复现，见 [`LICENSE-DATA.md`](./LICENSE-DATA.md)）。Jev 未开源、未披露参数量与架构，无法自托管。

> 一句话：Jev 擅长的是「高频、边界明确的判断」，而本项目的模型需求集中在**生成**与**语义相关性打分**上 ——
> 前者它做不了，后者已有开放权重方案且更省。将来若要引入类似思路，应当先用真实数据测准确率与成本，而不是因为「新且快」就换。

## 仓库结构

```
backend-cf/                     Cloudflare Workers 后端（Hono + TypeScript strict，28 个模块）
  src/index.ts                  路由 + 中间件（限流闸门 / 配额 / 鉴权）
  src/search.ts                 检索编排：校验 → embedding → 多库并行 → 合并 → rerank → 缓存
  src/topk.ts                   返回条数边界 / 匿名夹取 / 重排候选数（唯一真相源）
  src/quota.ts                  滚动窗口配额（网格锚定）+ 加权成本
  src/tiers.ts / ratecount.ts   分档判定 / D1 原子计数（HMAC 桶）
  src/keypool.ts                密钥池：扫描 POOL_KEYS_<n>、LRU 轮转、失败换 key
  src/keyadmin.ts               禁用集（KV `keydeny:keys`）+ 进程内缓存
  src/embeddings.ts / rerank.ts / llm.ts / chat.ts / fallback.ts
  src/searchcache.ts            KV 缓存（TTL 1h）
  src/ingestfiles.ts            零-chunk 文件集合（避免每轮空转）
  src/ingestruns.ts / usagestats.ts / adminstats.ts   观测聚合
  src/db/schema.sql              D1 表结构（+ schemaStatements.ts 幂等迁移）
  scripts/                       one-shot-import / ingest-incremental / bench_search
  tests/                         vitest（649 用例）
frontend/                       Nuxt3 + Tailwind v3 前端
  pages/{index,about,login,settings,admin}.vue
  functions/api/[[path]].ts     Pages Function：/api/* 同源反代（透传 body、SSE 不缓冲）
.github/workflows/ingest.yml    每日增量摄取
.github/workflows/watchdog.yml  每 30 分钟探活（6 项检查）
plan*.md / tasks.md / TODO.md / history.md   设计、任务、待办、交接
```

## 快速开始

### 后端（本地）

```bash
cd backend-cf
npm install
cp .dev.vars.example .dev.vars     # 填自己的 key（该文件已被 .gitignore 排除）
npm run dev                        # wrangler dev → http://127.0.0.1:8787
npm run typecheck                  # tsc --noEmit，必须 0 错
npm test                           # vitest，649 用例
```

> 若 `wrangler` 在受限环境下报配置目录不可写，加 `XDG_CONFIG_HOME=/tmp/wr-home XDG_CACHE_HOME=/tmp/wr-home`。

### 前端（本地）

```bash
cd frontend
npm install
npm run dev                        # http://localhost:3000，/api 经 vite proxy 转发到 :8787
npm run typecheck && npm run generate
```

## 环境变量与密钥

**密钥永不入库、永不进 git、永不出现在日志**：只放本地 `.dev.vars`（gitignored）、Cloudflare Secrets、GitHub Actions Secrets。

| 名称 | 用途 | 存放 |
|---|---|---|
| **`POOL_KEYS_0` / `POOL_KEYS_1` / …** | 硅基流动密钥池（**一把一个变量、数字递增、不要求连续**）。代码按前缀扫描 env；ref 由变量名派生（`POOL_KEYS_3` → `pool-key-3`），**加 key 只需新建一个变量，永不重打已有** | Worker Secret + GH Actions Secret |
| **`DS_POOL_KEY_0` / `DS_POOL_KEY_1` / …** | **开业酬宾专用池**（基元律动 tokenrhythm，与 `POOL_KEYS_<n>` **绝不混用**）。ref = `ds-pool-key-<n>` | Worker Secret |
| `DS_ENDPOINT` / `DS_MODEL` | 促销上游地址（**可写基础 URL**，代码会补 `/chat/completions`）与模型 id | `wrangler.jsonc` vars |
| `PROMO_ENABLED` / `PROMO_BUDGET_CNY` / `PROMO_DAYS` / `PROMO_QUOTA_WINDOW_TOKENS` / `PROMO_LLM_MAX_TOKENS` / `PROMO_TIMEOUT_MS` | 促销总开关 / 预算（默认 ¥136）/ 期限天数（30）/ 促销期配额（1M = 4×）/ 促销输出上限（4000）/ **促销链上游超时（默认 60s；不思考固定 25s 快速回退）** | `wrangler.jsonc` vars |
| `QDRANT_URL` / `QDRANT_API_KEY` | Qdrant Cloud 地址与 key | Worker Secret + GH Actions Secret |
| `ADMIN_API_KEY` | 运维端点认证（`/admin/*`） | Worker Secret + GH Actions Secret（供摄取/探活上报） |
| `PROXY_SHARED_SECRET` | Pages Function 与 Worker 之间的信任凭据（签名客户端 IP/国家/ASN，**必须配置**） | Worker Secret + Pages 环境变量 |
| `JWT_SECRET` | 会话 JWT 签名（HS256） | Worker Secret |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X OAuth 2.0 凭据 | Worker Secret |
| `CUSTOM_MODEL_ENC_KEY` | 自带模型 api_key 的 AES-GCM 密钥（缺失则相关接口 503） | Worker Secret |
| `ALLOWED_ORIGINS` / `OAUTH_REDIRECT_URI` / `FRONTEND_BASE_URL` | CORS / 回调 / 前端基址 | `wrangler.jsonc` vars |
| `REQUIRE_LOGIN` | `0`=匿名可用完整向量检索（当前）；`1`=匿名仅关键词回退 | `wrangler.jsonc` vars |
| `RATE_LIMIT_{LOGGED_IN,CN_RESIDENTIAL,CN_OTHER,CN_IDC,OVERSEAS,UNKNOWN}_PER_MIN` | 六个档位限额 | `wrangler.jsonc` vars |
| `RATE_LIMIT_LLM_DIVISOR` | LLM 限额 = 档位 ÷ 该值（默认 5） | `wrangler.jsonc` vars |
| `ANON_GLOBAL_PER_MIN` / `ANON_GLOBAL_HARD_PER_MIN` | 全局匿名软/硬熔断（当前 **300 / 600**；**两者不可设成同值**，否则"优雅降级带"消失） | `wrangler.jsonc` vars |
| `QUOTA_WINDOW_TOKENS` / `QUOTA_WINDOW_HOURS` | 窗口额度（默认 300000）/ 窗口长度（默认 5h） | `wrangler.jsonc` vars |
| `RERANK_OVERFETCH` / `RERANK_MAX_CANDIDATES` | 重排过采样系数（默认 3）/ 候选上限（默认 64） | `wrangler.jsonc` vars |
| `KEY_DENY_CACHE_TTL_SEC` | key 禁用集的进程内缓存秒数（默认 30，`0`=关闭） | `wrangler.jsonc` vars |
| `LLM_MODEL` / `LLM_ENDPOINT` / `LLM_MAX_TOKENS` / `LLM_ENABLE_THINKING` | AI 伴读配置（**思考链默认关闭**——Qwen3.5-4B 是思考模型，不关会把 token 预算吃光） | `wrangler.jsonc` vars |
| `NUXT_PUBLIC_API_BASE` | 前端调用基址（**含 `/api`**；生产走同源 `/api`） | CF Pages 环境变量 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查 |
| GET | `/api/v1/corpora` | 四个库的元信息与 chunk 数 |
| POST | `/api/v1/search` | 检索主接口：`{query, corpora, top_k(1–50), use_reranker, use_llm}` |
| POST | `/api/v1/search/stream` | SSE：`hits → session → citations → delta… → done`（需登录） |
| POST | `/api/v1/chat` | 多轮追问（`{session_id, question}`，上限 10 轮） |
| GET | `/api/v1/tree/:wiki_id` | 知识树（`wiki_id` 用连字符，如 `mtf-wiki`） |
| GET | `/api/v1/auth/oauth/x/start` / `callback` | X 登录（PKCE）；回调 302 回前端 `#token=<JWT>` |
| GET | `/api/v1/me` | 当前账号 + 配额 + `disclaimer_ack`（需 JWT） |
| POST | `/api/v1/me/disclaimer` | 记录/撤销免责确认（需 JWT） |
| GET/POST | `/api/v1/settings/models` | 自带模型列表 / 保存（含 `DELETE .../:id`） |
| GET | `/api/v1/admin/usage` | 账号维度用量总览 |
| GET | `/api/v1/admin/usage/summary?days=30` | **上游调用与 token 汇总**（按 endpoint / 按天；只读聚合） |
| GET | `/api/v1/admin/ratelimit` | 分档限流观测（各 scope 计数、熔断状态、封禁数） |
| GET | `/api/v1/admin/ingest/runs` / POST | 摄取历史 / 上报一条摄取结果 |
| GET/POST | `/api/v1/admin/ingest/files` | 零-chunk 文件集合（读 / 批量登记与移除） |
| GET/POST | `/api/v1/admin/keys` | key 池健康 / 上下架（**只出 `key_ref`，绝不回显密钥**） |
| GET | `/api/v1/admin/audit` | 审计日志 |
| GET | `/api/v1/admin/whoami` | 诊断：解析到的 IP / 档位 / 限额 / 代理信任状态 |
| GET | `/api/v1/admin/dsping` | 诊断：**从 Worker 内部**探促销上游（主机可达性 + 一次真实调用状态/耗时；不含密钥） |
| GET | `/api/v1/admin/d1bench` | 诊断（临时）：直连量一次 D1 读/写/批与 KV get/put 的真实耗时，用于定位延迟瓶颈 |
| POST | `/api/v1/admin/db/apply-schema` | 幂等应用 D1 schema + 迁移（wrangler 不可用时的 bootstrap 通道） |
| POST | `/api/v1/admin/accounts/:id/ban` / `/quota` | 封禁（`?unban=1`）/ 加额或重置窗口 |

```bash
curl -X POST https://search.chengxi.moe/api/v1/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"HRT 激素治疗","corpora":["mtf-wiki","ftm-wiki"],"top_k":10,"use_reranker":true}'
```

响应含 `hits[]`（`url` / `title` / `snippet` / `score`）、`timings`、`quota`（**百分比口径**）、`warnings`；降级时带 `fallback:true`。
`timings` 里另有诊断字段：`handler_ms`（Worker 内总耗时）、`gate_ms` 与 `gate_{block,burst,tier,global}_ms`（分档闸门各段）。

> **鉴权**：`/api/v1/search` 匿名可用（仅受分档限流）；`/me`、`/search/stream`、`/chat`、`/settings/models` 需 JWT；
> `/admin/*` 接受 `Bearer <ADMIN_API_KEY>` 或 `Bearer <JWT>` 且 `role=admin`。
> **未登录的 `top_k` 上限为 5**：超出会**夹取**（不报错）并在 `warnings` 里返回 `top-k-clamped-anon`；越界（0 / 51 / 非整数）返回 422 `invalid-top-k`。

## 数据管线

### 每日增量（推荐）

`.github/workflows/ingest.yml`：每天 **UTC 02:00** 自动跑，也可在 Actions 手动触发（`full=true` 强制全量、`wiki=<id>` 只跑单库）。

```bash
cd backend-cf
QDRANT_URL=... QDRANT_API_KEY=... POOL_KEYS_0=... GITHUB_TOKEN=... \
  npx tsx scripts/ingest-incremental.ts [--only=mtf-wiki] [--full] [--dry-run]
```

机制：GitHub trees API 一次拿到全部 `.md` 的 **git blob sha** → 与 Qdrant `payload.blob_sha` 比对 → 只解析/embed 变化文件 → 先按 **point id** 删旧点再 upsert；文件消失则删点。
**产出 0 chunk 的极短文件**会登记进 `ingest_files.blob_sha`，下一轮直接跳过（实测第二轮 `files=0`）。
每轮结束把摘要 `POST /api/v1/admin/ingest/runs` 上报，`/admin` 可看历史。

### 全量导入

```bash
cd backend-cf
QDRANT_URL=... QDRANT_API_KEY=... POOL_KEYS_0=... \
  npx tsx scripts/one-shot-import.ts [--dry-run] [--only=mtf-wiki] [--resume] [--local-dir=...]
```

### 原文链接规则

`payload.url` 存**各 wiki 官网**地址，「查阅官方原文」直接跳官网：

| wiki | 仓库路径 | 官网 URL |
|---|---|---|
| MtF | `content/zh-cn/docs/X.md` | `https://mtf.wiki/zh-cn/docs/X` |
| FtM（Hugo） | `content/<dir>/<file>.md` + frontmatter `slug` | `https://ftm.wiki/zh-cn/<dir>/<slug 或文件名>/` |
| RLE | `docs/X.md` | `https://rle.wiki/X` |
| Mio | `docs/X.md` | `https://mio.chengxi.moe/MioMtFWiki/X.html` |

规则实现在 `src/wikiUrl.ts`（摄取时生成）；存量数据可用 `POST /api/v1/admin/backfill-urls` 只改 payload 回填，**不需要重新 embedding**。

## 运维与观测

| 手段 | 内容 |
|---|---|
| **探活** | `.github/workflows/watchdog.yml` 每 30 分钟：① `/healthz` ② 四库接口（经反代）③ **一次真实匿名检索** ④ key 池是否有足够密钥 ⑤ 摄取是否 36h 内成功 ⑥ **今日上游调用量**是否超阈值（默认 1000/天）。失败 = job 非零退出 → GitHub 给管理员发邮件 |
| 用量 | `GET /api/v1/admin/usage/summary` 按 endpoint / 按天汇总上游调用与 token（上游长期免费，此处用于**发现异常量级**） |
| 限流观测 | `GET /api/v1/admin/ratelimit`（各档位计数、突发布尔、熔断状态、封禁数） |
| 诊断 | `GET /api/v1/admin/whoami`（解析到的 IP / 档位 / 限额 / 代理信任）；检索响应里的 `handler_ms` 等打点 |
| 摄取 | `GET /api/v1/admin/ingest/runs` + `/admin` 页面的「摄取历史」与 key 补货提示 |

## 隐私与合规

- 登录只用 X：DB **只存 `sha256(x_id)` 摘要**，用户名不落库；**不要求实名、不收手机号、不收邮箱**。
- **查询词不写数据库**；但相同查询的结果会在服务端 KV 缓存 **1 小时**（缓存键不与账号关联）。
- **AI 追问的会话内容**（你的问题、模型回答、命中片段摘要）会保存以支持多轮（上限 10 轮）。
- 防滥用计数按 IP 分档，但存的是**不可逆 HMAC 摘要**（不是明文 IP）。
- **AI 回答不是医疗建议**：可能出错或过时，用药/剂量请咨询医生；回答里 `[来源n]` 可点回原文核对。
  完整说明（数据来源、工作原理、隐私逐条、免责）见 **<https://search.chengxi.moe/about>**；首次访问会弹免责确认。

## 文档

- [`plan.md`](./plan.md) — 架构、模型选型与实测数据、决策记录
- [`plan-ratelimit.md`](./plan-ratelimit.md) — 分档限流、配额窗口、计数与熔断的完整设计 + 验收
- [`plan-topk.md`](./plan-topk.md) — 返回条数（1–50）与重排过采样、计费联动的定稿
- [`plan-keypool.md`](./plan-keypool.md) — 密钥池合并为 `POOL_KEYS_<n>` 的设计与迁移
- [`plan-m4.md`](./plan-m4.md) — M4 灰度与运营（探活/面板/月账/免责/演练）与总状态
- [`tasks.md`](./tasks.md) — 任务 DAG 与验收标准（M0–M4）
- [`TODO.md`](./TODO.md) — **只记还没做的**（含需要用户参与的项）
- [`history.md`](./history.md) — 跨会话交接：已锁决策、线上现状、**踩过的 50 个坑**
- [`task-second-domain.md`](./task-second-domain.md) — 备用域名接入步骤

## 部署

| 部件 | 平台 | 关键配置 |
|---|---|---|
| 后端 | Cloudflare Workers（Git 集成） | 根目录 `/backend-cf`，`npx wrangler deploy`；D1/KV/Queue 绑定由 `wrangler.jsonc` 生效 |
| 前端 | Cloudflare Pages（Git 集成） | 根目录 `/frontend`，构建 `npm run generate`，输出 `dist`，环境变量 `NUXT_PUBLIC_API_BASE=/api` |
| 反代 | Pages Function | `frontend/functions/api/[[path]].ts`（同源 `/api/*` → Worker；透传 body、SSE 不缓冲、302 的相对 `Location` 改绝对） |
| 摄取 | GitHub Actions | Secrets：`QDRANT_URL`、`QDRANT_API_KEY`、`POOL_KEYS_0/1/2`、`ADMIN_API_KEY` |
| 探活 | GitHub Actions | 同上（`ADMIN_API_KEY` 用于 ④⑤⑥ 三项管理检查） |

**D1 schema 与迁移**（本机 `wrangler` 不可用时的通道）：
```bash
curl -X POST https://search.chengxi.moe/api/v1/admin/db/apply-schema \
  -H "Authorization: Bearer <ADMIN_API_KEY>"    # 只执行固定的幂等 CREATE/ALTER
```

> 首次部署后在 Workers → Settings → Variables and Secrets 补齐密钥；Pages 自定义域先在 Pages → Custom domains 添加，
> 再去域名所在账号配 DNS（跨账号 CNAME 裸配会报 1014/1016，见 `history.md` 坑 17）。

## 许可

本项目采用**复合许可**（完整说明见 [`LICENSE-DATA.md`](./LICENSE-DATA.md)）：

| 对象 | 许可 |
|---|---|
| 代码（`backend-cf/`、`frontend/`、`scripts/`、`.github/` 等） | [GPL-3.0-or-later](./LICENSE) |
| 向量索引数据 · MtF / FtM / RLE 三库 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| 向量索引数据 · Mio MtF Wiki | [CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/)（**不对外分发**，且**不参与 AI 伴读**） |
| 各 wiki 条目原文 | 版权归原作者与译者所有，本项目仅做检索索引 |

**向量库不随仓库分发**（体积大 + Qdrant Cloud 按量计费、访问凭据不公开），但**复现方法公开**：
用开放权重的 `BAAI/bge-m3` 在 **1024 维**下对各 wiki 的 `.md` 文件向量化即可重建（脚本见 `backend-cf/scripts/`）。

医疗指引请以执业医生诊断为准。
