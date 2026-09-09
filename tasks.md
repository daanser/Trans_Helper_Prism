# TransHelper Prism — 任务拆解（tasks.md）

> 由 `plan.md` v0.2 拆出。决策基线（2026-09-07）：GPL-3.0 沿用；每月重置 5h；未登录/超额走结巴回退+登录引导；
> `use_reranker` 先默认开、M1 压测后终定；`use_llm` 默认关；Nuxt3 单前端 + **Cloudflare Workers 单后端**（复活 backend-cf，Python 废弃）；
> 模型**硅基流动中国站一家全包**（embedding bge + rerank + Qwen3-8B），**闲鱼成品号 + Key Pool**（embed/llm 分池、自动换 key）解决实名；
> Qdrant 不动（Qdrant Cloud 免费层）；绑定 X 为主+邮箱为辅且守隐私底线。
> 任务编号即推荐执行顺序；✅ = 验收标准。

---

## M0 项目骨架（0.5–1 周）——先让纯向量搜索跑通

### T0.0 连通实测（最高优先级，不通过则全方案重估）
- 写个 10 行 Worker：调 `api.siliconflow.cn` embedding + rerank + chat 各一次，记录连通性 + P50 延迟；
  同时建 Qdrant Cloud 免费集群，Worker 直连写/读一条验证。
- 买第 1 个闲鱼号：验余额/赠金 + 三个接口全通，再批量买。
- ✅ 三方全通才开 T0.1；任一不通立刻停下来重估，不许硬上。

### T0.1 仓库骨架（Workers + Pages，无服务器）
- 复活 `old-Trans-Search/backend-cf/` 为 `backend-cf/`（Hono 空壳：healthz + 路由占位 + `wrangler.jsonc` 配好 D1/KV/Queues）；
  `frontend/`（Nuxt3 空壳，Pages 托管）、D1 `schema.sql`（账号/绑定/配额/keys/ingest_runs/sessions/bigram_index）、`LICENSE`（GPL-3.0 全文）、README。
- ✅ `wrangler dev` + `nuxt dev` 全跑通；LICENSE 含 GPL-3.0；前后端各能跑 hello world。

### T0.2 Embedding 抽象 + Key Pool 骨架
- `src/embeddings.ts`：`EmbeddingProvider` 接口 + 硅基流动中国站 bge 实现；`src/keypool.ts`：embed_pool/llm_pool、
  轮询选 key、401/403/429/余额不足/超时自动换 key 重试、D1 用量记账、可用 key <2 告警（先日志，后接通知）。
  模型名/维度写进配置，查询与文档共用同一 instruction prefix。
- ✅ 单测（vitest）：换 key 重试逻辑（mock 第一个 key 401 → 自动用第二个成功）；超长截断不抛错；provider 可 mock 替换。

### T0.3 四库全量落库（`mtf_wiki_v1` / `ftm_wiki_v1` / `rle_wiki_v1` / `miomtfwiki_v1`）
- 旧 `script/indexer.py` 的 frontmatter 解析 + body 清洗用 **TS 重写**成 `src/ingest/parser.ts`
  （先做一次性全量导入脚本，4 个 repo：project-trans/MtF-wiki、FtM-wiki、rle-wiki + KitsuMio/MioMtFWiki，
  增量 Cron+Queue 留到 M2；全量跑时注意硅基流动 RPM，限流退避；先 `--dry-run` 数 chunks/token 再真跑）。
- point id = `sha1(wiki_id:path:chunk_index)`；collection metadata 存 `embedding_model/dim`。
- ✅ 4 库全量导入成功；抽查 5 篇文档 chunk 可还原原文 URL；重跑导入 point 数不变（幂等）；记下全量 token 数 × 单价 = 真实成本。

### T0.4 `POST /api/v1/search` 纯向量版（参数占位）
- 接受全部参数 `query/corpora/use_reranker/use_llm/top_k/model_id/session_id` 并校验
  （`corpora` 至少 1 个；M0 四个库都真检索：mtf-wiki/ftm-wiki/rle-wiki/miomtfwiki）；
  `use_reranker/use_llm=true` 时 M0 直接返回纯向量结果 + `warnings: ["reranker-not-yet", ...]`，不阻塞。
- 返回体含 `hits/timings/quota(fallback:false)/warnings`；Qdrant 多 collection 并行代码（M0 四个库都走同一路径）。
- ✅ 无 rerank/LLM 时 P50 < 2s（含 Workers→国内延迟，本地除外）；`timings` 四段都有值；参数非法返回 422；未登录可调通（M3 再加配额）。

### T0.5 前端最小搜索页
- Nuxt3：搜索框 + 向量库多选（M0 四个选项全上：mtf/ftm/rle/mio，做成数组可扩展）+ reranker/LLM 开关（UI 有，打开弹"即将上线"toast）
  + 结果列表（标题/来源/章节/片段/分数/原文链接）+ 耗时拆解显示。
- ✅ 手机+桌面可用；空结果/报错/加载态齐全；不直连任何模型 key（只调自家 API）。

**M0 出关标准**：T0.0 三方连通 → 端到端"搜中文 query → 看到四库结果 → 点进原文"，`corpora/use_reranker/use_llm` 参数已占位，Key Pool 骨架可用。

---

## M1 检索优化（1–2 周）——治 reranker 和性能

### T1.1 硅基流动 rerank 接入（走 llm_pool）
- `src/rerank.ts`：`RerankProvider` 接口 + 硅基流动中国站 rerank 实现，走 Key Pool（用量记到 llm_pool 账上）；
  **批量推理**（一次 HTTP 塞 batch 16/32 对，禁逐条循环——Workers→国内往返贵）；候选裁剪只取向量初排 top 30–50；
  `rerankTopK` 做成配置项（删旧魔法数字）。
- `use_reranker=false` 时链路物理跳过 rerank。
- ✅ 批量生效（日志证明 30 candidates ≤ 3 次上游调用）；可开关对照：同一 query 开关结果一致性可解释（rerank 只重排不增删）。

### T1.2 缓存 + 超时熔断 + timings
- 短期缓存（KV，5min TTL）：key = `norm(query)+corpora+top_k+use_reranker+embedding版本+rerank版本`（防串味）；
  reranker 硬超时 1.5s，超时/5xx/池全灭自动降级回向量序 + `warnings: ["rerank-fallback"]`。
- ✅ 相同查询 5 分钟内第二次命中缓存（`timings.cached=true`）；mock 上游全挂后搜索仍可用且带 warning。

### T1.3 关键词回退分支（Qdrant 全文索引版）
- `src/fallback.ts`：**2026-09-09 修订**——改用 Qdrant `payload.text` 全文索引（`tokenizer: multilingual`）检索命中 chunk，
  本地按 query token 命中度排序、按 path 去重取 top_k；
  触发：配额耗尽 / embedding-rerank-上游失败 / 未登录（M1 先实现"上游失败"触发，配额/登录触发点在 M3 接上）。
- 原「D1 bigram 索引」方案放弃：实测 1481 chunk 产生 521,925 行，超 D1 免费版 10 万行/天写入额度 5.2 倍（见 plan.md §5.4）。
- 返回 `fallback:true` + banner 文案约定。
- ✅ 断网（mock embedding 抛错）时自动回退且 0 embedding 调用；前端出现回退 banner；四个 collection 均已建 text 索引（实测「激素」「嗓音」命中）。

### T1.4 压测 + 定 reranker 默认开关（决策终点）
- 真实 wiki query 集（≥50 条，含短词/长句/错别字）测：recall@10、nDCG@10（开/关 rerank 对照），
  P50/P95（三路径：纯向量 / +rerank / +LLM首token——LLM 数据 M3 回填也行，先测前两路）。
- 输出表格对照 `plan.md §5` 目标（纯向量 P50<800ms 本地/边缘另议；+rerank P50<2s），**终定 `use_reranker` 默认开/关**并写回 plan。
- ✅ 压测脚本可重复跑（`scripts/bench_search.ts`，跑在 Workers 外调线上 API）；结论写入 plan.md（一句话 + 数据表）。

**M1 出关标准**：reranker 可开可关、可熔断、有缓存、有回退；压测数据决定默认开关。

---

## M2 数据管线（1 周）——干掉手动传资料

### T2.1 wiki 注册表 + 多 collection
- `src/wiki_registry.ts` 加载 wiki 配置（id/repo/branch/content_dir/site_url/chunk 参数，存 KV/D1）；
  collection 命名 `{wiki_id}_v1`，`GET /api/v1/corpora` 返回每库文档数/chunk 数/上次更新时间；
  `corpora` 多选真正生效（多 collection 并行检索 + 合并）。
- ✅ 四个库 M0 已有；M2 起新增第 5 个 wiki 只需改配置 + 跑导入，零代码改动；`corpora` 单选/多选结果正确合并去重。

### T2.2 每日增量更新（GitHub Actions 版）
- **2026-09-09 修订**：原「Cron + Queue」方案在 Cloudflare 免费版跑不动（CPU 10ms / 内存 128MB / 50 子请求，
  实测 `exceededMemory` / `exceededCpu`），迁到 **GitHub Actions**（`.github/workflows/ingest.yml`，每日 UTC 02:00 + 手动触发）。
- 流程（`backend-cf/scripts/ingest-incremental.ts`，Node 无 CPU/内存墙）：
  GitHub trees API 取全部 .md 的 git blob sha → 与 Qdrant `payload.blob_sha` 比对 → 只对变化文件解析分块
  → 批量 embed（走 embed_pool，限流退避）→ 先按 point id 删旧点再 Qdrant upsert → 消失文件删点。
- ✅ 实测：首次全量 1481 chunk 约 2 分钟；二次运行 `upserted=0`（真增量）；dry-run 的 chunk 数与库内点数逐库吻合（79/76/490/836）。
- 待办：`ingest_runs` 记账已不在本链路（D1 写入需另配 CF API token）；如需失败告警可加 Actions 通知。

### T2.3 parser/chunker 单测补齐
- 给 T0.3 的 TS parser 加单测：frontmatter（含 list）、shortcode、HTML 注释、多余空行、`_index.md` 目录元映射、
  标题分级分块 + overlap；chunk 记录 `{wiki_id,path,title,section,url,commit_sha,chunk_index,updated_at}` 全字段断言。
- ✅ `vitest` 全绿；造 3 篇脏 markdown fixture 覆盖上述 case。

### T2.4 知识树 API
- `GET /api/v1/tree/{wiki_id}` 按 `section_path` 聚合（标题/子章节/篇数/更新时间），数据源即 chunk 元数据，不另维护树。
- ✅ 前端 `/tree` 能浏览两 wiki；改名/移动路径的文章树自动跟随（靠下次 ingest 更新）。

**M2 出关标准**：双 wiki 在线、每日自动增量、删改正确、知识树可用。

---

## M3 账号、配额、LLM（1–2 周）——防滥用 + AI 问答

### T3.1 登录 + 强制绑定（含隐私底线）
- OAuth（X 优先，可选加 GitHub；Workers 内 `arctic` 类库）+ `jose` JWT（短 access + refresh）；账号↔绑定↔封禁表放 D1；
  未绑定只能结巴回退；**隐私条目逐项落实**：X 只取 id+handle、登录页明示用途、可解绑改绑邮箱、不存实名/手机、绑定标识落库最小化+日志/后台脱敏。
- ✅ 新用户流程走通：登录→未绑定只能回退→绑 X 或邮箱→向量可用→解绑改绑可用；DB 里无多余 X 字段；管理后台看到的是脱敏 id。

### T3.2 配额（每月 5h）计量扣减
- 权重表（初值，M4 可调）：纯搜索 1/s、+rerank +2、LLM 按 token 30–120/1k tokens、回退 0；
  KV 原子扣减；每次搜索返回 `quota.remaining`；<10% 前端提示；管理员手动加/扣接口。
- ✅ 超额后自动回退且不扣费；并发 20 下扣减无超卖（单测+压测）；月重置 Cron（先做手动触发接口+定时，时区 UTC）。

### T3.3 限流 + 封禁 + 审计
- IP/账号双维度限流（KV 计数，未登录按 IP+指纹）；异常频率熔断；管理员一键封禁/解封；敏感操作审计日志（封禁/加额/改模型配置/上架 key）。
- ✅ 刷接口触发 429；封禁账号立即只能回退（或 403，按定）；审计表可查谁何时封了谁。

### T3.4 LLM 总结/追问（Qwen3-8B，走 llm_pool）
- Workers 代理（前端永不碰 key）；system prompt 强制"只基于给定 hits、逐条标引用 `[来源n]`、不编造"；
  hits 截断（每条≤600字、共≤6条）；`max_tokens 800`、超时+换 key 重试、池全灭降级纯搜索 + `"AI总结暂不可用"`；
  `session_id` 多轮（最近 N 轮 + 初始 hits，超长截断，最多 10 轮）；`POST /api/v1/search/stream` SSE 流式。
- ✅ 有引用且引用 id 全部可点击回跳 hits；掐掉 LLM 上游后搜索不受影响；每轮追问都扣配额且前端可见。

### T3.5 自定义模型
- `/settings` 配 `base_url+api_key+model`（OpenAI-compatible），加密落库（WebCrypto AES-GCM，密钥放 secrets），仅本人请求可用；
  管理员可配多个服务端候选模型，`model_id` 白名单校验；日志永不打印 key，报错不回显。
- ✅ 用自定义 key 走完一次总结；换错 key 报错不泄露；他人拿不到我的 key（越权单测）。

### T3.6 前端：登录/配额/LLM/管理
- `/login`（OAuth+绑定）、剩余额度常驻显示+低额提示、开 LLM 二次确认弹窗、追问面板（桌面右/移动下）、
  `/settings`（默认 corpora/reranker/LLM 偏好+自定义模型）、`/admin`（用量/封禁/加额/ingest runs/模型白名单/**keys 上架禁用+每 key 用量**，路由鉴权）。
- ✅ 未登录态全站可用回退模式；剩余额实时；LLM 二次确认可取消；非管理员打 `/admin` 被拦。

### T3.7 邮件服务商选型（仅当保留邮箱绑定）
- Resend vs SES：比价格/到达率/接入成本，选定后接验证码发送 + 频率限制；若 X 绑定已够用，可降级为"邮箱仅备用"，本任务可延后。
- ✅ 验证码端到端可用；重发限流；成本记入运营账。

**M3 出关标准**：登录→绑定→配额→搜索→LLM追问→超额回退→封禁，全链路可演示；隐私 checklist 全勾；key 挂一个自动换，演示不断。

---

## M4 灰度与运营（持续）

- T4.1 小圈子内测（**key 补货/轮换演练一次**：下架一个 key 看自动切换；收集坏 case 回灌压测集）、权重调参、文档 + `/about`（GPL-3.0+致谢）。
- ✅ 内测反馈 issues 清零或排期；key 挂单演练通过；`plan.md` 性能表格回填真实数据；月账单（硅基流动 + CF）记入运营账。

---

## 跨阶段硬性要求（每个 M 都要满足）

1. **GPL-3.0**：新文件头加 license 声明；`LICENSE` 全文；前端 `/about` 许可与致谢可访问。
2. **key 隔离 + Pool**：所有硅基流动 key 只活在 Workers secrets/D1 加密字段，前端/日志/仓库永不出现；任何模型调用必须走 Key Pool（禁直调单 key）。
3. **隐私**：任何新增的用户字段先过一遍"最小必要？"再加；管理后台默认脱敏。
4. **可观测**：每次搜索 `timings` 必返；ingest 每次跑 `ingest_runs` 必记；每 key 用量可查。
