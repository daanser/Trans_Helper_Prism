# TransHelper Prism —— 跨会话交接（history.md）

> 给隔壁 subagent 看的上下文。实时 multimodel 细节以 `plan.md`（v0.2）为准，任务 DAG 以 `tasks.md` 为准。
> ⚠️ 真实 key 永不落文件：跑导入/联调要 `QDRANT_URL / QDRANT_API_KEY / EMBED_POOL_KEYS / LLM_POOL_KEYS`（内容就是硅基流动 key，逗号分隔），找用户要，mantra：只放内存环境变量、`backend-cf/.dev.vars`（gitignored）、CF Workers Secrets、GitHub Actions Secrets，绝不提交、绝不贴报告。
> **仓库已上 GitHub**（2026-09-09）：`https://github.com/daanser/Trans_Helper_Prism`（public，`main`）。线上：前端 `https://search.chengxi.moe`（备用 `https://transhelper-prism.pages.dev`）、后端 `https://transhelper-prism-backend.transprism.workers.dev`。

## 1. 项目一句话
重写已死的 `transhelper-transsearch`：Qdrant 向量检索四个性别/性少数中文 wiki（MtF / FtM / RLE / Mio），Cloudflare 全家桶承载，Nuxt3 前端。GPL-3.0（根 `LICENSE` 已放，DMCA 避险；新文件头加 `// SPDX-License-Identifier: GPL-3.0-or-later`）。

## 2. 架构（plan §2/§3）
- **backend-cf**（Hono + TS，Cloudflare Workers）：`src/index.ts`（路由 + Cron/Queue handler 仍在但已停用）→ `src/search.ts`（`runSearch`：校验→embedding→多 collection 并行→合并去重→timings；embedding 挂了自动切 `src/fallback.ts`）→ `src/embeddings.ts`（硅基流动）+ `src/keypool.ts`（Key Pool）→ Qdrant Cloud。`src/rerank.ts`（rerank）、`src/searchcache.ts`（KV 缓存）、`src/wiki_registry.ts`（wiki 配置）、`src/wikiUrl.ts`（官网 URL 生成）、`src/backfillUrls.ts`（存量 URL 回填）、`src/tree.ts`（知识树）。auth/配额/chat/admin 仍是 501 占位（M3）。
- **frontend**（Nuxt3 + Tailwind v3，dark class）：`pages/index.vue` + `SearchBox / HitCard / TimingsBar / Toast / ToggleMini / AiCompanionCard` + `composables/useApi.ts`（apiBase = `NUXT_PUBLIC_API_BASE`，见坑 18）+ `utils/renderSnippet.ts`（自研轻量 md 子集渲染，见 §6）。
- **数据管线（两套）**：
  - `scripts/one-shot-import.ts`：**全量**导入（tarball→自实现 tar 解包→`src/ingest/parser.ts`→embedBatch→Qdrant upsert）。支持 `--dry-run / --only / --resume / --local-dir`。
  - `scripts/ingest-incremental.ts` + `.github/workflows/ingest.yml`：**每日真·增量**（GitHub Actions）。GitHub trees API 一次取全部 `.md` 的 **git blob sha** → 与 Qdrant `payload.blob_sha` 比对 → 只解析/embed 变化文件 → 先按 **point id** 删旧点再 upsert；消失文件删点。**摄取不在 Worker 里跑**（免费版跑不动，见坑 13）。
- **M3 新增模块**：`src/auth.ts`（X OAuth2+PKCE + JWT 会话）、`src/quota.ts`（滚动 5h 窗口 + 加权 token）、
  `src/ratelimit.ts`（KV 双维度限流）、`src/audit.ts`（审计）、`src/llm.ts`（Qwen3.5-4B 总结/流式/多轮）、
  `src/chat.ts`（`chat_sessions` 多轮）、`src/custommodel.ts`（自带模型 AES-GCM 加密落库）、
  `src/adminstats.ts` + `src/keyadmin.ts`（管理端用量/keys、KV 禁用集）、`src/db/schemaStatements.ts`（Worker 内建表）。
- 单测：vitest（`tests/` 23 个文件、**351 用例**），`npx tsc --noEmit` 必须 0 错。

## 3. 已锁决策（别推翻，除非用户点头）
- 单供应商：**硅基流动中国站**。embedding `BAAI/bge-m3`（1024 维），rerank `BAAI/bge-reranker-v2-m3`（M1 已接、默认开），chat 默认 `Qwen/Qwen3.5-4B`（0.42s）备选 `GLM-4-9B-0414`——Qwen3-8B/Z1/2.5-7B 太慢已出局（plan §8.1 有实测表）。
- **Key Pool 是消耗品逻辑**：灰产号 key 不可轮换，挂了自动剔除、`<2` 告警补货、`/admin/keys` 热加载（M3）。pool 变量：`EMBED_POOL_KEYS / LLM_POOL_KEYS`（rerank 默认并入 llm）。
- Qdrant Cloud **悉尼区**（唯一 APAC 免费区），collection 名**下划线 canonical**：`mtf_wiki_v1 / ftm_wiki_v1 / rle_wiki_v1 / miomtfwiki_v1`（plan §7.1）。
- 四 wiki + 内容目录 + **分支**（实测 GitHub defaultBranch）：`project-trans/MtF-wiki@**master**`→`content/zh-cn`（只收中文，不要 ja/zh-hant/en）、`project-trans/FtM-wiki@main`→`content/`、`project-trans/rle-wiki@main`→`docs`、`KitsuMio/MioMtFWiki@main`→`docs`。
- **URL 规则（2026-09-09 定，已取代「URL 默认 GitHub blob」）**：`payload.url` 存**各 wiki 官网**，前端「查阅官方原文」直指官网。逐库规则（`src/wikiUrl.ts`，已浏览器实测可打开）：
  - mtf：`content/zh-cn/docs/X.md` → `https://mtf.wiki/zh-cn/docs/X`（去 `.md`，无尾斜杠）
  - ftm（**Hugo**）：`content/<dir>/<file>.md` + frontmatter `slug` → `https://ftm.wiki/zh-cn/<dir>/<slug 或文件名>/`（**尾斜杠**；如 `hrt-overview.md`+`slug: overview` → `/zh-cn/hrt/overview/`）
  - rle：`docs/X.md` → `https://rle.wiki/X`
  - mio：`docs/X.md` → `https://mio.chengxi.moe/MioMtFWiki/X.html`（`md`→`html`；走 chengxi 反代，规避 github.io 被墙）
- **回退检索 = Qdrant 全文索引**（2026-09-09 改，非 D1 bigram，见坑 14）：四个 collection 已建 `text` 索引（`tokenizer: multilingual`，中文实测可用）。
- 配额：每月 5h/账号；未登录 = fallback + 登录提示；reranker 默认开；LLM 默认关。
- **登录 = 仅 X OAuth 2.0 + PKCE**（`arctic`）；邮箱绑定**已取消**（T3.7：邮件服务商要域名验证+花钱）。会话是**无状态 JWT**（`jose` HS256，30 天），
  前端存 localStorage 走 `Authorization: Bearer`——不用 Cookie（前端与 Worker 跨站，第三方 Cookie 会被浏览器拦）。
- **⚠️ 隐私硬要求（用户明确）**：DB **只落 `sha256(x_id)`**（`bindings.identifier`），`provider_id` 恒 NULL、`accounts.handle` 空串；
  handle 只活在会话 JWT 里（每次登录从 X 重取）。改这段代码前先想清楚。
- **配额 = 滚动 5 小时窗口 + 加权 token + 只显示百分比**（2026-09-09 用户澄清，取代旧「每月 5h」）：
  满 5h 自动开新窗口；额度 `QUOTA_WINDOW_TOKENS`（默认 300000）；权重 纯搜索 200 / +rerank +100 / LLM 按真实 tokens / 回退 0；
  存 D1 `quotas`（`period_start`=window_start、`used_cost`=used_tokens，零 DDL）。
- **匿名可用完整向量检索**（`REQUIRE_LOGIN=0`）：仅靠限流挡滥用；限流 IP **10 次/分钟**、账号 60 次/分钟（env 可调）。
  要改回「匿名仅关键词回退」把 `REQUIRE_LOGIN` 设 `1`。
- admin 端点鉴权 = `Bearer <ADMIN_API_KEY>` **或** `Bearer <JWT>` 且 `role=admin`；角色在**登录时写进 JWT**，改了 `ADMIN_X_IDS` 必须**重新登录**才生效。
- 前端约束：最小栈，不引重型 UI 库 / 重型 md 库；UI/UX 走 §6 的自定「温润学术检索」风（中文标签、中性统一徽章、无高饱和彩虹色、无全大写终端风）——此为已锁方向，改前先问用户。

## 4. 线上现状（2026-09-09）
- **后端**：CF Workers `transhelper-prism-backend`，经 **Git 集成**从 GitHub `main` 自动部署（root dir = `/backend-cf`，deploy = `npx wrangler deploy`）；绑定 D1 `transhelper-prism` / KV `SEARCH_CACHE` / Queue（已不消费）。`/api/v1/corpora`、`/api/v1/tree/:wiki_id`、`/api/v1/search`（POST）全通。
- **前端**：CF Pages `transhelper-prism`（root `/frontend`，build `npm run generate`，输出目录 **`dist`**，见坑 16），自定义域 `search.chengxi.moe`（跨账号 CNAME，见坑 17）。
- Qdrant 四库共 **1481 points**：mtf 490 / ftm 79 / rle 836 / mio 76。payload 必含 `text`（snippet/LLM context 全靠它）+ wiki_id/path/title/section/**url（官网）**/commit_sha/chunk_index/updated_at/**blob_sha（增量比对）**。
- 真搜 P50：embed ~0.2s + search ~1.2s（本地打悉尼），四库 1.4–2.2s；`timings.cached` 命中 KV 时跳过 embed+Qdrant。
- **摄取**：GitHub Actions `ingest`，每日 UTC 02:00（北京 10:00）+ 手动 `workflow_dispatch`（可传 `full=true` / `wiki=<id>`）。首次全量 1481 chunk ≈2 分钟；二次运行 `upserted=0`（真增量生效）。
- **密钥落点**：CF Workers Secrets（`EMBED_POOL_KEYS / LLM_POOL_KEYS / QDRANT_URL / QDRANT_API_KEY / ADMIN_API_KEY`）；GitHub Actions Secrets（`QDRANT_URL / QDRANT_API_KEY / EMBED_POOL_KEYS`；`GITHUB_TOKEN` 自动注入）。
- 本地联调：后端 `:8787`（`wrangler.local.jsonc`，本地 D1/KV/Queue mock）+ 前端 `:3000`。dev 进程跨轮次会被回收，死了重起（后端要 `XDG_CONFIG_HOME=/tmp/wr-home XDG_CACHE_HOME=/tmp/wr-home`，命令禁加 `| head`）。
- **本环境 `wrangler` 子命令坏**（`deploy/d1/whoami` 全报 `Unknown arguments: <cli.js>, <cmd>`，只有 `dev` 能跑）→ 部署走 CF Dashboard 的 Git 集成，D1/Qdrant 操作用 REST API / `curl`。

- **账号/配额（M3 已上线）**：`accounts`/`bindings`/`quotas`/`audit_log`/`custom_models` 表均已应用到线上 D1；
  线上已有 1 个真实账号（登录跑通）、配额窗口与百分比计费实测正确。
- **路由全景**：`GET /healthz`、`GET /api/v1/corpora`、`GET /api/v1/tree/:wiki_id`、`POST /api/v1/search`、
  `GET /api/v1/auth/oauth/x/start|callback`、`GET /api/v1/me`、`POST /api/v1/search/stream`（SSE）、`POST /api/v1/chat`、
  `GET|POST|DELETE /api/v1/settings/models[/:id]`、`GET /api/v1/admin/usage`、`GET|POST /api/v1/admin/keys`、
  `GET /api/v1/admin/audit`、`POST /api/v1/admin/accounts/:id/ban|quota`、`POST /api/v1/admin/db/apply-schema`、
  `POST /api/v1/admin/ingest/trigger`、`POST /api/v1/admin/backfill-urls`（后两个仍 ADMIN_API_KEY-only）。
- **Secrets 清单**：Worker = `EMBED_POOL_KEYS`/`LLM_POOL_KEYS`/`QDRANT_URL`/`QDRANT_API_KEY`/`ADMIN_API_KEY`/
  `X_CLIENT_ID`/`X_CLIENT_SECRET`/`JWT_SECRET`/`CUSTOM_MODEL_ENC_KEY`；GitHub Actions = `QDRANT_URL`/`QDRANT_API_KEY`/`EMBED_POOL_KEYS`。
- 前端已上线三个新页面：`/login/`、`/settings/`、`/admin/`（注意 CF Pages 对预渲染路由会 308 到带尾斜杠版本）。

## 5. 踩过的坑（新人必读，单测抓不到的）
1. `fetch` 存引用再 `this.fetchImpl()` → workerd 报 **Illegal invocation**（Node 正常）。修法：`embeddings.ts` 的 `defaultFetch = (...args) => fetch(...args)`，所有默认 fetch 走它（含 `search.ts` 查 Qdrant 那路）。
2. `withKeyRetry` 曾吞首错 → 现已把首错拼进抛错（`换 key 后仍无可用 key（首错 …）`），保留。
3. tar 自实现解包必须支持 GNU `'L'/'K'` 长文件名（MtF 108 字符路径），且只收 `.md`（MtF 有 143MB 图片/PDF，误读曾虚高出 12 万 chunks）。
4. chunker 用**贪心合并**（短章节合并到 ~1200 字符），别按标题一切一块（会碎成 ~100 字符）。
5. collection 名横杠/下划线两边必须一致（曾导致三库静默查空；单库失败被吞是设计，但"库不存在"以后要打 warning，M1 做）。
6. payload 漏 `text` 曾导致 snippet 全空——导入脚本里别删。
7. 前端代理：nitro `devProxy`/`routeRules` 会吃 `/api` 前缀（worker 收到 `/v1/search` 404），**只用 `vite.server.proxy`**；`NITRO_PRESET` 条件 preset（本地 node，部署构建才 cloudflare_module）。
8. `useApi.ts` 曾双拼 `/api`（baseURL `/api` + 路径 `/api/v1/search`），已修为 search 传 `/v1/search`。再动拼接先查 worker 日志实际路径。
9. debug 路由必须放 `const app` 声明之后（TDZ 会炸 runtime），用完删（已删）。
10. macOS bash 3.2 无关联数组；`~/.npm`、`~/.wrangler` 可能 root 拥有 → 用项目内 `.npm-cache`、`/tmp/wr-home` 绕。
11. 模板里 `<img src="/xxx.svg">` 会被 Vite 当模块资源解析：若 dev server 启动时 `frontend/public/` 尚不存在，会 500（`ENOENT open '/xxx.svg'`）。修法：小 logo 直接**内联 SVG** 进模板，或确保 `public/` 在起服务前已存在。
12. 自定义 Tailwind token 类（如 `bg-signal`/`border-hairline`）若 config 改动后未被重编译，元素会「有类无样式」直接隐身（开关轨道/滑块就是这么消失的）。稳妥：交互关键件用标准 Tailwind 调色板类（`bg-blue-600` 等），别依赖热重载 config。
13. **Cloudflare 免费版跑不动 Worker 内摄取**：限额 **CPU 10ms / 内存 128MB / 单次 50 子请求**。Worker 里下载整仓 tarball + `gunzipSync` + 全量 embed → 日志 `eventType: queue` 且 `outcome: exceededMemory / exceededCpu`，**`ingest_runs` 从未落过成功记录**（所以「自动增量」长期没生效却不易察觉）。已迁 GitHub Actions，`wrangler.jsonc` 不再注册 crons。
14. **D1 免费版每天只允许写 100,000 行**（官方 pricing；读 500 万行/天，单库 500MB）。实测 1481 chunk 的 bigram 索引需 **521,925 行**（超 5.2 倍）→ 回退检索放弃 D1 bigram，改用 Qdrant 全文索引。
15. **Qdrant 两个坑**：① 按 payload 过滤删除（`filter.must[].match`）要求该字段**先建索引**，否则 400 `Index required but not found for "path"` → 改用**按 point id 删除**；② 中文全文检索必须 `tokenizer: "multilingual"`，默认 word 分词对无空格中文无效（建索引：`PUT /collections/{c}/index`）。
16. **CF Pages 上 Nuxt 的构建输出目录是 `dist`**（Pages 环境 Nitro 自动切 `cloudflare-pages-static`），不是本地 `npm run generate` 的 `.output/public`；填错 → `Output directory "frontend/.output/public" not found`。
17. **CF 跨账号 CNAME 到 Pages 会 1014（CNAME Cross-User Banned）/ 1016（Origin DNS error）**：必须在 **Pages → Custom domains** 里先加域名（CF 给出确切记录）再去另一账号配 DNS，别裸加 CNAME。
18. **前端 `NUXT_PUBLIC_API_BASE` 必须带 `/api` 后缀**：`useApi` 是 `base + "/v1/search"` 拼接，漏了 `/api` 会请求 `.../v1/search` → 404（后端与 CORS 都正常，极易误判成 CORS 问题）。
19. **GitHub API 匿名限额 60 次/时**：本地或 CI 调 trees/commits API 必须带 token（Actions 用 `secrets.GITHUB_TOKEN`）；`gh` CLI 缓存目录 `~/.cache/gh` 可能 EPERM → `export XDG_CACHE_HOME=/tmp/gh-cache`。
20. **`old-Trans-Search/`（含真 key）已 gitignore**，未进公开仓库；`.dev.vars` 同理。`gh` 已登录 `daanser`（keyring），可直接 `gh secret set`（经 stdin 传值，别放命令行参数）。
21. **Nuxt `_index.md` 处理**：`buildDirMeta` 只认 `_index.md`，但 Worker 版 ingest 曾在建 dirMeta **之前**就把 `_index.md` 过滤掉了（section 标题退化）；GH Actions 脚本已修正为「`_index.md` 参与 dirMeta、但不入库 chunk」——与原始 `one-shot-import.ts` 行为一致。

22. **SSE 必须带 `Cache-Control: no-cache, no-transform`**：否则 CF 会缓冲压缩首 token，流式变「憋一大坨再吐」。事件名用命名事件（`event: delta` + `data:{"text":…}`），别按 `data: [DONE]` 写死。
23. **KV 不能当精确计数器**：无原子自增 + 多边缘最终一致 → 并发下计数偏低。限流用它（够用），**配额记账必须走 D1 原子 `UPDATE`**。
24. **`KeyPoolDb.listActiveKeys` 从未被消费**：所以「禁用某把 key」不能靠 DB 生效，我们另存 KV 禁用集 `keydeny:<pool>`，由 `KeyPool.usableKeys()` 过滤；KV 丢了就回到全部可用（fail-open 的必然代价）。
25. **admin 角色烧写在 JWT 里**：`ADMIN_X_IDS` 改动后旧 token 仍是 `user`，必须重新登录；否则 `/admin` 一直 401，很容易误判成鉴权 bug。
26. **`git add -A` 会把并行 subagent 的在制品一起提交**（我踩过）：多人/AI 并行改同一仓库时，提交前先 `git status` 看清文件归属，别用 `-A` 一把梭。
27. **本环境 `wrangler` 全废**（`Unknown arguments: cli.js, …`，连 `dev` 也不行，系 Electron 把 `process.execArgv` 污染）：本地验证走 `app.request()`（Hono 直调）+ 内存 KV/D1；**线上 DDL 走 `POST /api/v1/admin/db/apply-schema`**（只执行固定的幂等语句）。
28. **CF Pages 预渲染路由会 308 到带尾斜杠**：OAuth 回跳若落 `/login` 会多一跳（fragment 按规范会继承，但为稳妥我们直接回跳 `/login/`）。
29. **上游流式常不返回 `usage`**：LLM token 记账会退化成按字符估算（`estimated:true`）；要精确就得让上游开 `stream_options.include_usage` 或改用非流式结算。

30. **OAuth 回调的 `Location` 必须是绝对 URL**：若发相对路径 `/login#token=…`，浏览器会按**当前域**解析——回调发生在 Worker 域，于是跳到 `https://<worker>/login#token=…` → 404 且登录态不生效（线上踩过，用户贴回跳 URL 才定位）。修法：`sanitizeRedirect` 一律 `new URL(raw, base).toString()`，`loginRedirectUrl` 只接受 `http(s)://` 开头、否则回落前端默认页。
31. **`recordUsage` 原先只有 `llm.ts` 会调用**：`embeddings.ts` / `rerank.ts` 虽接收 `KeyPoolDb` 却从不记账 → `/admin/usage` 里「只搜索不开 LLM」的账号 `requests` 永远是 0。修法：给 `withKeyRetry` 加可选 `onAttempt` 回调（成功/失败都回调、回调抛错被吞），embeddings/rerank 在回调里写 `key_usage`（批量路径另补两处）。
32. **`key_usage` 加列不能用 `CREATE TABLE IF NOT EXISTS` 补**（SQLite 无 `ADD COLUMN IF NOT EXISTS`）：迁移语句要单独导出，apply-schema 先跑迁移再建表，并把 `duplicate column name` / ALTER 的 `no such table` 视为成功（其它错误仍 failed）。**部署顺序硬要求：先 deploy，再立刻 POST apply-schema**——迁移完成前 `/admin/usage` 会 503（故意报错而不是显示假 0）。
33. **登录回跳 fragment 要在 Nuxt 启动前消费**：放在 `onMounted` 里可能因水合/路由初始化重写 URL 而读不到 hash；现改为 `nuxt.config.ts` head 内联脚本先落 `localStorage.prism_token` 并清 hash（`useAuth.consumeHashToken` 保留作兜底，错误信息经 `sessionStorage` 传递）。

34. **X 的 `/2/users/me` 必须有 `tweet.read`**：曾按"只取 id+username"把 OAuth scope 收窄成只 `users.read`，结果回调 403（前端 `登录失败（x-users-me-failed status=403）`）。**默认 scope 必须两条**，别删；`X_OAUTH_SCOPES` env 只是个实验口子，改完必须真机走一次登录。

35. **KV 限流会「抢跑」分档限流**：R2 修好真实 IP 之后，KV 限流（原 `RATE_LIMIT_IP_PER_MIN=10`）突然开始生效，会**先于** D1 分档把登录用户（60/min）在第 11 次挡掉。分档上线时必须把 KV 两项调到**高于所有档位**（现为 120/120）当粗兜底，真正的判定交给 D1。
36. **测固定窗口限流必须对齐窗口边界**：12 次间隔 0.3s 的请求跨越了分钟边界 → 被拆成 7+5，两个窗口都没到 10，于是"限流没生效"是我的测法问题，不是代码问题。正确测法：等到整分钟边界再开始（`while [ "$(date +%S)" != "00" ]; do sleep 0.2; done`）。
37. **`peek` 的 `degraded` 不能把「无行」当「读失败」**：新窗口第一次请求前表里本来就没有行，`readCount` 返回 null 是正常的；线上曾据此把正常状态报成 `rate_count_degraded=true`，我据此误判限流失效排查了很久。真读异常要由 try/catch 兜。
38. **D1 分档计数的写放大是 3 行/匿名请求**（分档桶 + 突发桶 + 全局桶），比 plan 里"1 写/请求"高；免费版 10 万写/天 ≈ 3.3 万次匿名检索。突发桶"热了才写"会更省但会漏计使突发层架空，故按正确性优先。

39. **别把「不装重型依赖」扩大解释成「不许用任何库」**：M3 那个 subagent 把用户的约束理解成"禁止引 md 库"，于是 AI 回答一直是纯文本渲染；用户后来明确「你用呗」。
   现在用的是 **`markdown-it`（`html:false`）**——一条依赖就把 md 渲染做对，安全上比自研解析器更稳（原始 HTML 全转义、危险协议被 `validateLink` 拦掉）。
   **教训**：约束要按原话执行，拿不准就问，别自行加码。
40. **流式 AI 回答必须给「内部独立滚动」**：卡片原来是 `lg:sticky` 但**没有滚动容器**，内容一长（追问会不断追加到同一个 `answer` 字符串）就只能滚整页，`sticky` 也失效。
   修法：消息区 `max-h-* + overflow-y-auto + overscroll-behavior: contain`（后者是关键——否则滚动链会穿透到页面，用户会觉得"我滚它整页都跟着动"），
   并且**只在用户贴着底部时才自动跟随**（`scrollHeight - scrollTop - clientHeight < 48`），否则用户上翻读历史会被反复拽回底部。

41. **`/about` 的隐私与免责声明必须与代码行为逐条一致**（2026-09-11 建立，改动下列任一行为都要同步改 `/about`）：
   实测核对结果（写声明时的事实基础）：
   - 账号：`accounts` 只存 `id/created_at/status`（`handle` 恒为空串）；X 身份只在 `bindings.identifier` 存 **sha256 摘要** → 声明里说"只存 id 的 SHA-256 摘要、用户名不落库"是准确的。
   - **检索缓存**：`src/searchcache.ts` 的 key 是 `vec:<归一化查询词>|<库>|<top_k>`，**含查询词明文**，KV TTL **3600s**（1 小时）→ 声明里必须写"查询词不写数据库，但相同查询结果会在服务端缓存约 1 小时、不与账号关联"，**不能**说成"完全不记录查询"。
   - **AI 追问会话**：`chat_sessions.history` 保存消息（含用户问题与 AI 回答）+ `initial_hits` 摘要 → 声明里必须写"会话内容会保存以支持多轮（≤10 轮）"。
   - **限流计数**：`rate_counters.bucket_key` 是 `HMAC(secret, scope|tier|ip|窗口)`，**不含 IP 明文** → 声明里写"不可逆 HMAC 摘要"是准确的。
   - 审计日志只记管理员动作，不含用户检索内容。
   **教训**：对外声明是最容易被代码演进"悄悄说错"的东西 —— 改缓存/会话/计数相关代码时，顺手核对 `/about`。
42. **医疗免责是产品必需项，不是文案装饰**：语料与 AI 输出都涉及 HRT/用药，现已在三处落地 ——
   AI 卡片常驻一行（"可能出错或过时，不能替代医生建议；请以 [来源n] 原文为准"）、`/about` 顶部醒目区块、登录页隐私段指向 `/about`。
   改动 AI 卡片或删除 `/about` 前请先想清楚这一点。
   **2026-09-11 追加：免责改为默认弹窗**（`components/DisclaimerDialog.vue` + `composables/useDisclaimer.ts`）：
   - 同意 = 双写（localStorage `prism_disclaimer_ack` + 登录时的 `accounts.disclaimer_ack_at`）；
     **版本串 `DISCLAIMER_VERSION`（现 `v1`）改成 `v2` 即可让所有人重新看一次** —— 改了条款就该重新告知，这是合规动作。
   - **点遮罩不关闭**是有意的：误触遮罩若等于「我知道了」就是在用户最需要知情的一刻静默代签。
   - 判定链：`ready（客户端已读盘，SSR 期恒不弹）&& !acked && !dismissedSession && !serverAck`；
     `serverAck` 只由 `loadMe` 成功后写入，因此自带"已登录"语义，避免 `useAuth` ↔ `useDisclaimer` 循环依赖。
   - 已登录且 `/me` 在途时**先不弹**，避免"别的设备确认过"的用户看到弹窗又消失。
   - 已知取舍：本地 ack 是**设备级**（不带账号标识）→ 同一浏览器换账号登录不会再弹；且**有意不**把本地 ack 反推给服务端
     （否则共享电脑上 A 的确认会静默代表 B 同意）。

43. **`/search` 的端到端延迟真凶是 KV 写（650ms/次），不是 D1 往返**（2026-09-11 两轮优化 + 线上实测；**本条曾有一段写错，已更正**）
   - 第一轮我把 D1 往返从 **19 次压到 5 次**（`db.batch` 合并；单测用「可数 D1 mock」锁死），
     **但线上 TTFB 几乎没动** → 我当时的判断（D1 是瓶颈）**是错的**，教训见下。
   - 加打点后拆解真相（单发一次登录 `/search`，改前）：
     `handler=5621ms`，其中 `gate=2276ms`（内部分段只解释 461ms）、`quota≈1770ms`、检索管线 `1572ms`。
   - 用临时基准端点 `/admin/d1bench` 直接量单次成本，才看清：
     **D1 `batch`(3 条) 只要 120–180ms**；而 **KV put 635–653ms、KV get 未命中 260–496ms、KV get 命中仅 4ms**。
     那"消失的 1.8s"正是 **KV 限流器对 account+ip 各一次 get+put 的 2 次 put**；
     `loadDeniedKeys` 每请求还要一次 KV 读（当时没有任何 key 被禁用，即**永远白读**）；
     而**检索缓存的写是 `await` 的**（650ms），比它省下的 embed（~500ms）还贵。
   - 第二轮据此修三处：① **摘掉热路径的 KV 限流器**（功能冗余 + 早已因跨 colo 不收敛被否 + 最贵）；
     ② 禁用集改**进程内缓存**（TTL 默认 30s，`KEY_DENY_CACHE_TTL_SEC`）；③ 缓存**写**改 `waitUntil` 不阻塞响应。
   - **实测结果**：`gate 2276ms → 247–383ms`；`handler 5621ms → 2455–2784ms`（冷启 3711ms）；
     **端到端 TTFB 5.6–6.0s → 3.1–3.4s（登录）/ 1.9–3.1s（匿名）**。
   - **教训（方法层面，比结论更值钱）**：优化前先**分段打点**再动手。我第一轮凭"往返次数多"就认定 D1 是瓶颈，
     改了 19→5 却没效果，白花一轮；加上 `handler_ms`/`gate_*_ms` 打点 + 一个临时 D1/KV 基准端点，
     十分钟就定位到真凶。**"我以为的瓶颈"和"实测的瓶颈"经常不是一回事。**
   - 剩下的延迟构成（稳态）：检索管线 ~1.9s（embed ~0.65 + Qdrant ~0.65 + rerank ~0.6，都是跨境上游调用）+ 闸门 ~0.25s + 配额 ~0.3s + 边缘/网络 ~0.7s。
     再想快就得动上游（关 rerank 省 0.6s 但首条命中率 -10pp；或换更近的服务商）。
44. **压测要防三个坑**：① 同一 query 第二次会被 **KV 向量阶段缓存**命中（key 里**不带 rerank 开关**），
   所以"rerank 关→开"两次跑同一 query 时，第二次的 `cached=true` 是正常的、数值仍可比；
   ② 用**匿名**身份跑基准会被分档限流掐（我方出口是境外档 10/min）→ 用**登录 token**（60/min）跑；
   ③ 每次 `curl` 都新建连接会把 TLS 握手算进墙钟 → 测端到端要用 `--next` 复用连接，或分开看 TTFB。

45. **限额/限流的真实目的是"防止上游账号被打成风险号"，不是省钱**（2026-09-11 用户澄清，此前我按"成本"推演，方向错了）：
   - **reranker 与 embedding 都是白嫖的硅基流动（免费额度）→ 单次调用不花钱**；
     真正的风险是**请求量级/频率异常**被上游识别为滥用 → **封号** → 那时再买号才产生成本。
   - 所以设计取舍要按"**降低被判定为滥用的概率**"来评估，而不是按"每次调用多少钱"：
     · **限流器（分档 + 突发 + 全局熔断）才是主要护栏** —— 它约束的是**请求频率**，也就是封号风险本身；
     · 配额（weighted token）主要是**分配公平性**与"给用户一个可理解的额度"，不是成本计量；
     · 因此"按 n 计费"（返回条数）**不改变上游调用次数**（embed 恒 1 次、Qdrant 恒 1 次），
       对"防封号"这个目标**没有作用**；真正相关的是 rerank 的**候选批次数**（每批 32 条，封顶 64 → ≤2 批）。
   - **教训**：给功能定"收费/限制"规则前，先问清**限制是为了防什么**。我先前用"成本"和"防抓取"两种理由推演，
     用户都否掉了 —— 真实理由是第三种（防封号）。这类动机不该靠猜。

46. **本机网络会整段失效，且症状极易被误判成"线上挂了"**（2026-09-11 实测踩到）：
   - 症状：**所有** curl 返回 `000`（无响应），包括 `https://www.cloudflare.com/`、`https://1.1.1.1/`、`https://api.github.com/`；
     `dig` 只返回 **fake-IP（198.18.x.x）**；DoH（cloudflare-dns.com）也失败；curl 退出码 35（SSL connect error）。
   - **误判风险**：当时我刚推送了一次部署，差点断定"部署把线上搞挂了"。**正确的判别方法**：
     ① 先 curl 一个**与我们无关的公网站点**（如 `1.1.1.1`）—— 它也 `000` 就说明是本机链路问题；
     ② 别信 `/tmp` 里上一次请求留下的响应体（`curl -o` 失败时文件不会被覆盖，会给你"旧的成功响应"，看起来像服务是好的）。
   - 恢复后无需任何补救动作：部署本身早已完成（`git push` 成功即触发），只是**验收**得推迟。

47. **`git push ... && echo "✅ 已推送"` 这种写法会**静默吞掉失败**（2026-09-11 踩到，代价是白等一次部署）：
   网络整段失效时循环重试 5 次全失败，但命令**什么都不打印**，我据此以为推送成功、还去"等部署 55 秒"，
   实际上**功能提交根本没上去**。**正确写法**：重试循环里显式判断结果并打印失败，例如
   `for i in 1..5; do git push -q origin main && { echo pushed; break; } || echo "push failed ($i)"; sleep 6; done`，
   之后用 `git log --oneline origin/main..HEAD`（**必须为空**）或 `git status -sb` 复核"真的推上去了"。
   **原则：部署类操作要有正向证据（远端 ref 比对），不能靠"命令没报错"推断。**

## 6. 前端现状（2026-09-08 全量重写 UI/UX；2026-09-09 已上线 Pages）
- **设计语言已彻底换掉**：不再是照搬 `vitepress-theme-project-trans` 的 indigo 色板。现为自定「温润学术检索」风——浅底 `#F8FAFC` / 深底 `#0B1120`，品牌蓝 `#2563EB`（深 `#3B82F6`），token 全走 `assets/css/main.css` 的 CSS 变量（`--bg-canvas/--bg-surface/--text-*/--primary*`），`tailwind.config.ts` 只做语义映射（`canvas/surface/primary/ink`）。
- **用户明确否决过的方向（别再走回头路）**：① 高饱和四色彩虹 wiki 徽章（粉/天蓝/紫/翠绿）——太 AI 味；② 纯黑 `bg-slate-900` 实色选中块——太凝重死寂；③ 全大写英文终端风标签（`ARCHIVE RETRIEVAL //`、`SEARCH`、`PERF //`）——读不懂。现方案：四库**统一中性**选中态（淡蓝底 `bg-blue-50/80` + 勾选 `✓`，无彩色区分），中文标签，`max-w-7xl` 宽屏。
- **`ToggleMini.vue` 开关**：曾因引用未编译的自定义 token 类（`bg-signal` 等）导致轨道/滑块不显示；现改用标准 Tailwind 类（`bg-blue-600` 轨道 + `translate-x-[18px]/[2px]` 白钮），浅/暗双模均实测正常。
- **Logo**：用工作区根 `logo_foreground.svg`（六边形线框 + TP 字母，天蓝 `#5BCEFA` / 粉 `#F5A9B8`）。**内联**进 `app.vue` 顶栏深色徽底（`bg-slate-900`），非 `<img src>`——见 §5 坑 11。同文件已复制到 `public/` 作 favicon（`nuxt.config.ts` `app.head.link`）。
- **外链**：顶栏 + 页脚各两个——`TransPrism`→`https://transprism.chengxi.moe`、`TransHelper`→`https://transhelper.org`（Project Trans 的 github 链接已按用户要求全删）。
- **社交分享元信息（2026-09-09）**：`nuxt.config.ts` 的 description 与 og:title/og:description/og:site_name **已中性化**（去掉「Project Trans」归属，用户明确要求）；Discord 对已抓取的 URL 有 og 缓存，需等其刷新或换链接验证。
- `utils/renderSnippet.ts`：转义优先+白名单标签（p/strong/em/del/code/pre/a/ul/ol/li/blockquote/table/br/mark/hr），ATX 标题 `{#anchor}` 剥离降级加粗，`javascript:/data:` 链接降级纯文字，图片只留 alt；`stripMarkdown()` 给标题；query 高亮只包文本节点（CJK 单字保留）。摘要排版样式 `.snippet-reading` 在 `main.css`。
- **M3 新页面（2026-09-09）**：`/login`（读 `#token=`/`#error=`→存 token→清 hash→跳首页）、`/settings`（配额百分比条 + 检索偏好 + 自定义模型）、
  `/admin`（用量/keys/封禁/加额/审计，需 admin；非 admin 显示无权）、顶栏 `@handle + 剩余 xx%`、AI 二次确认 + SSE 流式 + `[来源n]` 回跳、追问走 `POST /v1/chat`。
  管理端在浏览器里只能「看状态」——封禁/加额/审计要 admin 会话（或运维 `ADMIN_API_KEY`）。
- `npm run typecheck`（nuxi typecheck）通过；浏览器 `:3000` 真搜联动实测（浅色/暗色、命中 10 条、开关与四库选择交互）OK；线上 `search.chengxi.moe` 实测可搜。

## 7. 当前进度与未做（M1–M4 见 tasks.md）
- **M0 / M1 / M2 / M3 已完成并上线**：
  - M1：rerank 批量+可开关（默认开）、KV 缓存、超时熔断、关键词回退（Qdrant 全文索引）、压测终定（plan §5.2 有表）
  - M2：四库 registry、知识树、解析单测、**真·文件级增量**（blob_sha 比对，跑在 GitHub Actions）
  - M3：X 登录（隐私只存哈希）、滚动 5h 配额（百分比口径）、限流（IP 10/min、账号 60/min）、封禁+审计、
    LLM 流式总结 + 多轮追问、自定义模型（AES-GCM 加密）、管理端 usage/keys/audit、匿名开放向量检索
- **M4（灰度与运营）未开**：内测反馈、压测复跑、月账、月度重置/运营面板等。
- **已知遗留（接手先看）**：
  1. `/admin/usage` 的每账号 `requests` / `llm_tokens_*` 恒为 `null`——`key_usage` 表没有 `account_id` 列，要真值需给该表加列并把记账接上账号维度。
  2. `KeyPoolDb.listActiveKeys` 仍未消费（跨 isolate 的 key 剔除不落库）；当前真相源是 KV 禁用集（无 TTL，清空即全部可用）。
  3. 反滥用第二层（CF 边缘限流规则 / Turnstile）**刻意暂缓**——用户决策「被刷了再加」。KV 限流已能挡异常频率。
  4. 自定义模型只有保存/列表/删除，没有「设为默认」与调用统计；`/admin/keys` 只出 ref 不出密钥（设计如此）。
  5. `ingest_runs` 记账仍未接（GH Actions 无 D1 访问）；`bigram_index` 表保留但不用；`/api/v1/admin/ingest/trigger` 只有 Workers Paid 才有意义。
  6. 产出 0 chunk 的极短文件每次增量都会被复核（无 payload 可存 `blob_sha`），影响可忽略。
  7. 配额窗口重置是「读取时判断」，没有后台任务；若将来要主动清理过期窗口需另加。

## 8. M4（灰度与运营）与技术债清单（2026-09-09 汇总）

> 功能性大块只剩 **M4**；其余是技术债与可选优化。限流相关（R1–R7）见 `plan-ratelimit.md`。

### 8.1 M4：灰度与运营（尚未开始）
| 事项 | 说明 |
|---|---|
| **内测反馈收集与清零** | 找真实用户（跨性别社群）试用，收集条目逐条建账 |
| **压测复跑** | 跑 20 条真实 query（plan §5.2 有基线表）；重点看新限流手感：`BURST_PER_10S=20` 的 60 秒硬封禁会不会误伤正常用户 |
| **月账** | 硅基流动（embedding/rerank/LLM）+ Cloudflare 用量与账单，记入运营账 |
| **运营面板** | `/admin` 的封禁/加额/审计目前是"可看不可点"（需 admin 会话或运维 `ADMIN_API_KEY`）；`/admin/ratelimit` 已有观测 |
| **域名冗余** | `task-second-domain.md`（等 `transhelper.org` 账号权限）|

### 8.2 技术债（按建议优先级）—— **2026-09-11：1/2/3/4 已清除**
> 清除批次：本地提交 `3743c2c` + `b93a3ad`（已推送）。验证：tsc 0 错、**537 用例全绿**；
> 线上 `apply-schema` 26 条语句（`tolerated` 仅预期的重复列、`failed` 空）；
> `/admin/usage.requests` 实测随登录搜索 0→1；`POST/GET /api/v1/admin/ingest/runs` 实测可用；
> GitHub Actions 手动触发一轮，4 个 wiki 全部上报 `HTTP 200` 并落进 D1。

1. **✅ `ingest_runs` 记账已接**（原：Actions 无 D1 绑定 → 后台看不到摄取历史）
   - 新增 `POST/GET /api/v1/admin/ingest/runs`（admin 鉴权）→ **由 Worker 代笔写 D1**，Actions 不持有 D1 凭据；
   - `scripts/ingest-incremental.ts` 支持 `INGEST_SUMMARY_PATH` 写机器可读摘要；`.github/workflows/ingest.yml` 末步
     `if: always() && env.ADMIN_API_KEY != ''` + `continue-on-error: true` 上报（未配 secret 自动跳过、失败不阻断）；
   - 需要在仓库 Secrets 配 `ADMIN_API_KEY`（已配）。
   - **副产品**：这套观测立刻量化了下面的 #5 —— 实测 `rle-wiki files=3 points=0`，即"极短文件每轮被复核"确实在发生。：摄取跑在 GitHub Actions、没有 D1 访问权 → 后台看不到摄取历史。接法：给 Actions 配一个最小权限的 CF API Token，或让 Actions 调 `POST /admin/db/apply-schema` 之外的记账端点（需新端点）。
2. **✅ `bigram_index` 已清除**：注意 **`src/bigram.ts` 本身没死**（`fallback.ts` 用它的 `splitBigrams` 做本地重排打分，**已保留**）；
   死的是**表 + 写入路径**：移除了摄取里的 `writeBigramRow` 与 `DELETE FROM bigram_index`，schema 去掉建表，
   并加幂等迁移 `DROP TABLE IF EXISTS bigram_index`（已在线执行）。
3. **✅ `KeyPoolDb.listActiveKeys` 已删除**（从未被任何代码消费）。key 的跨请求禁用**以 KV 禁用集 `keydeny:<pool>` 为唯一真相源**；
   `provider_keys.enabled` 仅供管理端展示与审计。
4. **✅ `/admin/usage.requests` 已是真实用户请求数**：`quotas` 增列 `requests`，在 `chargeQuota` 的**同一条原子 UPDATE**
   里 `requests = requests + 1`（零额外写）；并有 `try { 带 requests } catch { 不带 requests }` 兜底 —— **迁移前也不会坏**。
   口径：额度耗尽走回退的请求不扣费、因而不计入该列。
5. **✅ 产出 0 chunk 的极短文件已不再每轮复核**（2026-09-11 完成并线上验证）
   - **根因**：这类文件没有 Qdrant point → 没有 payload 可存 `blob_sha` → 每轮都被当新文件重新解析（永远空转）。
   - **修法**：`ingest_files` 增列 **`blob_sha`**（与 Worker 侧的 `content_hash` **分工不同、互不干扰**），
     在集合里的 = `blob_sha` 非空的行；新增 `GET/POST /api/v1/admin/ingest/files`（admin，批量，单请求上限 2000 条）
     由脚本跑前拉取、跑后回报；判据收敛到 `src/ingestfiles.ts` 的 `shouldProcessFile()`：
     `--full` → 处理；`payloadSha === treeSha` → **跳过（Qdrant 主判据，行为与改造前逐字节一致）**；否则看集合。
   - **线上实测**：第一轮登记（mtf **78** 条、ftm 16 条、rle 3 条），**第二轮全部 `files=0`**
     且日志显示「无变更（243 个 .md，其中 78 个零 chunk 文件已登记），跳过」。
   - **顺手修掉一个隐患**：Worker 侧 `upsertIngestFile` 原用 `INSERT OR REPLACE`（= DELETE+INSERT）**会把 Actions 写入的
     `blob_sha` 抹成 NULL** → 改为 `ON CONFLICT DO UPDATE`（对 Worker 自身语义不变，已在真实 SQLite 上验证差异）。
   - 上限行为只影响"少记/少返回几条"，被漏掉的文件下一轮会补登记，**正确性不受影响**（响应带 `truncated` 可观测）。
6. **配额窗口无主动清理任务**：靠"读取时判断"，够用；若将来要清理历史行再另加 cron。
7. **`ASN` 清单是初始值**：需按真实流量校准（`plan-ratelimit.md` §4.1 有方法：APNIC/iptoasn + `asOrganization` 关键词筛选）。
8. **前端可选**：自定义模型「设为默认」；LLM 回答的轻量 markdown 渲染（用户已否决引 md 库，可自研极简版）；i18n。
9. **`R7`（混合计数省写放大 / Turnstile 兜匿名 AI）→ 用户判断"用处不大"，暂不做**。触发条件：匿名检索逼近免费额度（10 万行写/天 ≈ 3.3 万次匿名检索/天），或真的被刷。

### 8.3 已知的"不是 bug，但要知道"的现象
- **经反代的延迟有尖峰**：Worker 自报 `total_ms` 2.7–4.2s（Qdrant 检索 ~2.1s + rerank 0.6–2.1s），正常情况下反代只多 ~0.5s；
  但实测出现过 13–20s 的尖峰，且 `cf-ray` 显示请求被分到**远端 colo**（如 WAW）——属**链路/节点调度**波动，不是代码问题。
  若用户在浏览器看到 502，优先确认是 **CF 边缘错误页** 还是我们的 `{"error":"upstream-unreachable"}`（后者 = Pages Function 的 30s 超时）。
- **响应头 `content-encoding: br` 是 CF 边缘二次压缩**：Pages Function 会删掉上游的 `content-encoding`，边缘再按客户端的 `accept-encoding` 重新压缩并加上该头 —— 正常现象（`curl` 不加 `--compressed` 会看到乱码）。
