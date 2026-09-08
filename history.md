# TransHelper Prism —— 跨会话交接（history.md）

> 给隔壁 subagent 看的上下文。实时 multimodel 细节以 `plan.md`（v0.2）为准，任务 DAG 以 `tasks.md` 为准。
> ⚠️ 真实 key 永不落文件：跑导入/联调要 `QDRANT_URL / QDRANT_API_KEY / SILICONFLOW_API_KEY`（+ `EMBED_POOL_KEYS / LLM_POOL_KEYS`，内容就是硅基流动 key，逗号分隔），找用户要， mantra：只放内存环境变量或 `backend-cf/.dev.vars`（gitignored），绝不提交、绝不贴报告。

## 1. 项目一句话
重写已死的 `transhelper-transsearch`：Qdrant 向量检索四个性别/性少数中文 wiki（MtF / FtM / RLE / Mio），Cloudflare 全家桶承载，Nuxt3 前端。GPL-3.0（根 `LICENSE` 已放，DMCA 避险；新文件头加 `// SPDX-License-Identifier: GPL-3.0-or-later`）。

## 2. 架构（plan §2/§3）
- **backend-cf**（Hono + TS，Cloudflare Workers）：`src/index.ts`（路由）→ `src/search.ts`（`runSearch`：校验→embedding→多 collection 并行→合并去重→timings；embedding 挂了自动切 `src/fallback.ts` 桩）→ `src/embeddings.ts`（硅基流动）+ `src/keypool.ts`（Key Pool）→ Qdrant Cloud。若干路由 501 占位（auth/配额/chat/tree/admin，M1–M3）。
- **frontend**（Nuxt3 + Tailwind v3，dark class）：`pages/index.vue` + `SearchBox / HitCard / TimingsBar / Toast / ToggleMini / AiCompanionCard` + `composables/useApi.ts`（apiBase 相对 `/api`）+ `utils/renderSnippet.ts`（自研轻量 md 子集渲染，见 §6）。
- **数据管线**（`scripts/one-shot-import.ts`）：GitHub tarball→自实现 tar 解包→`src/ingest/parser.ts`（frontmatter/清洗/_index.md 目录元/贪心合并 chunker maxChars 1200）→ embedBatch（batch 32）→ Qdrant upsert。支持 `--dry-run / --only / --resume / --local-dir`。
- 单测：vitest（`tests/`：parser/embedBatch/tar/keypool/search），`npx tsc --noEmit` 必须 0 错。

## 3. 已锁决策（别推翻，除非用户点头）
- 单供应商：**硅基流动中国站**。embedding `BAAI/bge-m3`（1024 维），rerank `BAAI/bge-reranker-v2-m3`（M1 接），chat 默认 `Qwen/Qwen3.5-4B`（0.42s）备选 `GLM-4-9B-0414`——Qwen3-8B/Z1/2.5-7B 太慢已出局（plan §8.1 有实测表）。
- **Key Pool 是消耗品逻辑**：灰产号 key 不可轮换，挂了自动剔除、`<2` 告警补货、`/admin/keys` 热加载（M3）。pool 变量：`EMBED_POOL_KEYS / LLM_POOL_KEYS`（rerank 默认并入 llm）。
- Qdrant Cloud **悉尼区**（唯一 APAC 免费区），collection 名**下划线 canonical**：`mtf_wiki_v1 / ftm_wiki_v1 / rle_wiki_v1 / miomtfwiki_v1`（plan §7.1）。
- 四 wiki + 内容目录：`project-trans/MtF-wiki@master`→`content/zh-cn`（只收中文，不要 ja/zh-hant/en），`project-trans/FtM-wiki@main`→`content/`，`project-trans/rle-wiki@main`→`docs`，`KitsuMio/MioMtFWiki@main`→`docs`。URL 默认 GitHub blob 链接。
- 配额：每月 5h/账号；未登录 = fallback + 登录提示；reranker 默认开（待 M1 压测终定）；LLM 默认关。
- 前端约束：最小栈，不引重型 UI 库 / 重型 md 库；UI/UX 走 §6 的自定「温润学术检索」风（中文标签、中性统一徽章、无高饱和彩虹色、无全大写终端风）——此为已锁方向，改前先问用户。

## 4. 线上现状（2026-09-07/08）
- Qdrant 四库共 **1481 points**：mtf 490 / ftm 79 / rle 836 / mio 76。payload 必含 `text`（snippet/以后 LLM context 全靠它）+ wiki_id/path/title/section/url/commit/chunk_index/updated_at。
- 真搜 P50：embed ~0.2s + search ~1.2s（本地打悉尼），四库 1.4–2.2s。
- 本地联调：`:8787`（`wrangler.local.jsonc`，无 D1/KV/Queue 绑定，M2 再接）+ `:3000`。dev 进程跨轮次会被回收，死了重起（后端要 `XDG_CONFIG_HOME=/tmp/wr-home XDG_CACHE_HOME=/tmp/wr-home`，命令禁加 `| head`）。
- M0 闭环 ✅。M1 待开：rerank 接入 + KV 缓存 + 超时熔断 + D1 bigram 真回退 + 压测。

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

## 6. 前端现状（2026-09-08 全量重写 UI/UX；本仓库无 git，用文件现状为准）
- **设计语言已彻底换掉**：不再是照搬 `vitepress-theme-project-trans` 的 indigo 色板。现为自定「温润学术检索」风——浅底 `#F8FAFC` / 深底 `#0B1120`，品牌蓝 `#2563EB`（深 `#3B82F6`），token 全走 `assets/css/main.css` 的 CSS 变量（`--bg-canvas/--bg-surface/--text-*/--primary*`），`tailwind.config.ts` 只做语义映射（`canvas/surface/primary/ink`）。
- **用户明确否决过的方向（别再走回头路）**：① 高饱和四色彩虹 wiki 徽章（粉/天蓝/紫/翠绿）——太 AI 味；② 纯黑 `bg-slate-900` 实色选中块——太凝重死寂；③ 全大写英文终端风标签（`ARCHIVE RETRIEVAL //`、`SEARCH`、`PERF //`）——读不懂。现方案：四库**统一中性**选中态（淡蓝底 `bg-blue-50/80` + 勾选 `✓`，无彩色区分），中文标签，`max-w-7xl` 宽屏。
- **`ToggleMini.vue` 开关**：曾因引用未编译的自定义 token 类（`bg-signal` 等）导致轨道/滑块不显示；现改用标准 Tailwind 类（`bg-blue-600` 轨道 + `translate-x-[18px]/[2px]` 白钮），浅/暗双模均实测正常。
- **Logo**：用工作区根 `logo_foreground.svg`（六边形线框 + TP 字母，天蓝 `#5BCEFA` / 粉 `#F5A9B8`）。**内联**进 `app.vue` 顶栏深色徽底（`bg-slate-900`），非 `<img src>`——见 §5 坑 11。同文件已复制到 `public/` 作 favicon（`nuxt.config.ts` `app.head.link`）。
- **外链**：顶栏 + 页脚各两个——`TransPrism`→`https://transprism.chengxi.moe`、`TransHelper`→`https://transhelper.org`（Project Trans 的 github 链接已按用户要求全删）。
- `utils/renderSnippet.ts`：转义优先+白名单标签（p/strong/em/del/code/pre/a/ul/ol/li/blockquote/table/br/mark/hr），ATX 标题 `{#anchor}` 剥离降级加粗，`javascript:/data:` 链接降级纯文字，图片只留 alt；`stripMarkdown()` 给标题；query 高亮只包文本节点（CJK 单字保留）。摘要排版样式 `.snippet-reading` 在 `main.css`。
- `npm run typecheck`（nuxi typecheck）通过；浏览器 `:3000` 真搜联动实测（浅色/暗色、命中 10 条、开关与四库选择交互）OK。

## 7. 当前未做（M1–M4 见 tasks.md）
M1：T1.1 rerank（走 llm_pool）→ T1.2 KV 缓存 → T1.3 超时熔断 + D1 bigram 真回退 → T1.4 压测终定 reranker 开关。M2 多 wiki 增量（Cron+Queue+D1 `ingest_runs` 记账）。M3 账号/配额/LLM 总结。M4 上线。
