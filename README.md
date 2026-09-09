# TransHelper Prism

> 跨性别与性少数中文 wiki 的**语义检索**：把 MtF Wiki、FtM Wiki、RLE Wiki、Mio MtF Wiki 四部知识库聚合成一个搜索框，
> 向量检索 + 二次重排，结果直达原文。全站跑在 Cloudflare（Workers + Pages + D1/KV），向量库用 Qdrant Cloud。

[![ingest](https://github.com/daanser/Trans_Helper_Prism/actions/workflows/ingest.yml/badge.svg)](https://github.com/daanser/Trans_Helper_Prism/actions/workflows/ingest.yml)

- **线上站点**：<https://search.chengxi.moe>（备用 <https://transhelper-prism.pages.dev>）
- **后端 API**：<https://transhelper-prism-backend.transprism.workers.dev>
- **许可证**：[GPL-3.0](./LICENSE)

---

## 功能

| 能力 | 说明 |
|---|---|
| 四库语义检索 | 一次查询跨 MtF / FtM / RLE / Mio 四部 wiki，可按库勾选 |
| 向量 + 重排 | `BAAI/bge-m3`（1024 维）向量召回 → `BAAI/bge-reranker-v2-m3` 二次重排（可开关） |
| KV 缓存 | 相同 query 5 分钟内命中缓存，跳过 embedding 与向量检索（`timings.cached=true`） |
| 超时熔断 | embedding / rerank / Qdrant 各自独立超时；单库失败不影响其它库，带 `warnings` 返回 |
| 关键词回退 | 上游全挂时自动降级为 **Qdrant 全文索引**检索（零 embedding），返回 `fallback:true`，前端展示 banner |
| 知识树 | `GET /api/v1/tree/:wiki_id` 从 chunk 元数据聚合出目录树 |
| 原文链接 | 每条命中直指**各 wiki 官网**（非 GitHub 源码），规则见下方「原文链接规则」 |
| 每日增量 | GitHub Actions 按 **git blob sha** 做文件级 diff，只重嵌变化文件 |

## 架构

```
                    ┌──────────────────────┐
  浏览器 ──HTTPS──▶ │  Nuxt3 前端 (Pages)   │  search.chengxi.moe
                    └──────────┬───────────┘
                               │ POST /api/v1/search
                    ┌──────────▼───────────┐
                    │ Workers 后端 (Hono)   │  transhelper-prism-backend
                    │  search / rerank /    │
                    │  cache / fallback     │
                    └───┬──────────┬────────┘
        ┌───────────────┘          └──────────────┐
        ▼                                          ▼
┌───────────────┐   embed / rerank        ┌───────────────┐
│ Qdrant Cloud  │◀───────────────────────│ 硅基流动 中国站 │
│ 4 collections │                         │ bge-m3 / rerank│
│ + text 索引   │                         └───────────────┘
└───────▲───────┘
        │ upsert / delete（按 point id）
┌───────┴───────────────────────────────────────────────┐
│ GitHub Actions：每日增量摄取（Node，无 Workers 限额）    │
│ trees API 取 blob sha → 与 payload.blob_sha 比对 → 重嵌 │
└───────────────────────────────────────────────────────┘
```

> **为什么摄取不跑在 Worker 里**：Cloudflare 免费版限制 CPU 10ms / 内存 128MB / 单次 50 子请求，
> Worker 内下载 tarball + gunzip + 全量 embed 必然 `exceededMemory` / `exceededCpu`。
> 详见 [`history.md`](./history.md) 坑 13/14。

## 仓库结构

```
backend-cf/                 Cloudflare Workers 后端（Hono + TypeScript strict）
  src/index.ts              路由 + Cron/Queue handler（摄取已迁出，crons 已停用）
  src/search.ts             检索编排：校验 → embedding → 多库并行 → 合并 → rerank → 缓存
  src/rerank.ts             硅基流动 rerank provider
  src/fallback.ts           关键词回退（Qdrant 全文索引）
  src/searchcache.ts        KV 缓存
  src/wiki_registry.ts      四个 wiki 的配置（repo / 分支 / content_dir / 官网）
  src/wikiUrl.ts            官网 URL 生成规则（ingest 期用）
  src/backfillUrls.ts       存量数据 URL 回填（只改 payload，不重嵌）
  src/tree.ts               知识树
  src/ingest/               parser / tar 解包 / GitHub 取数 / 增量管线
  src/db/schema.sql         D1 表结构
  scripts/                  one-shot-import（全量）/ ingest-incremental（增量）/ bench_search
  tests/                    vitest（147 用例）
frontend/                   Nuxt3 + Tailwind v3 前端
.github/workflows/ingest.yml  每日增量摄取
plan.md / tasks.md / history.md  设计、任务 DAG、跨会话交接
```

## 快速开始

### 后端（本地）

```bash
cd backend-cf
npm install
cp .dev.vars.example .dev.vars     # 填入自己的 key（该文件已被 .gitignore 排除）
npm run dev                        # wrangler dev → http://127.0.0.1:8787
npm run typecheck                  # tsc --noEmit，必须 0 错
npm test                           # vitest，147 用例
```

> 若 `wrangler` 在受限环境下报配置目录不可写，加 `XDG_CONFIG_HOME=/tmp/wr-home XDG_CACHE_HOME=/tmp/wr-home`。

### 前端（本地）

```bash
cd frontend
npm install
npm run dev                        # http://localhost:3000，/api 经 vite proxy 转发到 :8787
```

生产构建需显式指定后端地址（**必须带 `/api` 后缀**，否则会拼成 `/v1/search` 而 404）：

```bash
NUXT_PUBLIC_API_BASE=https://transhelper-prism-backend.transprism.workers.dev/api npm run generate
```

## 环境变量与密钥

**密钥永不入库**：只放本地 `.dev.vars`（gitignored）、Cloudflare Workers Secrets、GitHub Actions Secrets。

| 名称 | 用途 | 存放 |
|---|---|---|
| `EMBED_POOL_KEYS` | 硅基流动 embedding key（可逗号分隔多个，轮换用） | Worker Secret + GH Actions Secret |
| `LLM_POOL_KEYS` | 硅基流动 LLM/rerank key | Worker Secret |
| `QDRANT_URL` / `QDRANT_API_KEY` | Qdrant Cloud 地址与 key | Worker Secret + GH Actions Secret |
| `ADMIN_API_KEY` | 运维端点认证（`/admin/*`） | Worker Secret |
| `ALLOWED_ORIGINS` | CORS 白名单（逗号分隔） | `wrangler.jsonc` vars |
| `EMBEDDING_MODEL` / `EMBEDDING_DIM` / `RERANK_MODEL` 等 | 模型与端点 | `wrangler.jsonc` vars |
| `NUXT_PUBLIC_API_BASE` | 前端调用的后端基址（**含 `/api`**） | CF Pages 环境变量 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查 |
| GET | `/api/v1/corpora` | 四个库的元信息与 chunk 数 |
| POST | `/api/v1/search` | 检索主接口（见下） |
| GET | `/api/v1/tree/:wiki_id` | 知识树（`wiki_id` 用连字符，如 `mtf-wiki`） |
| POST | `/api/v1/admin/ingest/trigger` | 手动触发摄取（`ADMIN_API_KEY` 认证；**仅 Workers Paid 有意义**） |
| POST | `/api/v1/admin/backfill-urls` | 存量 URL 回填，支持 `offset`/`page_size` 分页续跑 |

```bash
curl -X POST https://transhelper-prism-backend.transprism.workers.dev/api/v1/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"HRT 激素治疗","corpora":["mtf-wiki","ftm-wiki"],"top_k":5,"use_reranker":true}'
```

响应含 `hits[]`（每条带 `url` / `title` / `snippet` / `score`）、`timings`、`quota`、`warnings`，降级时带 `fallback:true`。

## 数据管线

### 每日增量（推荐）

`.github/workflows/ingest.yml`：每天 **UTC 02:00** 自动跑，也可在 Actions 页面手动触发（可传 `full=true` 强制全量、`wiki=<id>` 只跑单库）。

```bash
cd backend-cf
QDRANT_URL=... QDRANT_API_KEY=... EMBED_POOL_KEYS=... GITHUB_TOKEN=... \
  npx tsx scripts/ingest-incremental.ts [--only=mtf-wiki] [--full] [--dry-run]
```

机制：GitHub trees API 一次拿到全部 `.md` 的 **git blob sha** → 与 Qdrant `payload.blob_sha` 比对 → 只解析/embed 变化文件 → 先按 **point id** 删旧点再 upsert；文件消失则删点。实测二次运行 `upserted=0`。

### 全量导入

```bash
cd backend-cf
QDRANT_URL=... QDRANT_API_KEY=... EMBED_POOL_KEYS=... \
  npx tsx scripts/one-shot-import.ts [--dry-run] [--only=mtf-wiki] [--resume] [--local-dir=...]
```

### 原文链接规则

`payload.url` 存**各 wiki 官网**地址，前端「查阅官方原文」直接跳官网：

| wiki | 仓库路径 | 官网 URL |
|---|---|---|
| MtF | `content/zh-cn/docs/X.md` | `https://mtf.wiki/zh-cn/docs/X` |
| FtM（Hugo） | `content/<dir>/<file>.md` + frontmatter `slug` | `https://ftm.wiki/zh-cn/<dir>/<slug 或文件名>/` |
| RLE | `docs/X.md` | `https://rle.wiki/X` |
| Mio | `docs/X.md` | `https://mio.chengxi.moe/MioMtFWiki/X.html` |

规则实现在 `src/wikiUrl.ts`（摄取时生成）；存量数据可用 `POST /api/v1/admin/backfill-urls` 只改 payload 回填，**不需要重新 embedding**。

## 部署

| 部件 | 平台 | 关键配置 |
|---|---|---|
| 后端 | Cloudflare Workers（Git 集成） | 仓库根目录 `/backend-cf`，部署命令 `npx wrangler deploy`；D1/KV/Queue 绑定由 `wrangler.jsonc` 自动生效 |
| 前端 | Cloudflare Pages（Git 集成） | 根目录 `/frontend`，构建 `npm run generate`，**输出目录 `dist`**，环境变量 `NUXT_PUBLIC_API_BASE=<后端地址>/api` |
| 摄取 | GitHub Actions | Secrets：`QDRANT_URL`、`QDRANT_API_KEY`、`EMBED_POOL_KEYS`（`GITHUB_TOKEN` 自动注入） |

> 首次部署后需在 Workers → Settings → Variables and Secrets 补齐密钥；Pages 自定义域需先在
> Pages → Custom domains 添加，再去域名所在账号配 DNS（跨账号 CNAME 裸配会报 1014/1016）。

## 文档

- [`plan.md`](./plan.md) — 架构、模型选型与实测数据、决策记录
- [`tasks.md`](./tasks.md) — 任务 DAG 与验收标准（M0–M4）
- [`history.md`](./history.md) — 跨会话交接：已锁决策、线上现状、**踩过的 21 个坑**

## 许可

[GPL-3.0-or-later](./LICENSE)。条目内容版权归各 wiki 原作者所有，本项目仅做检索索引；医疗指引请以执业医生诊断为准。
