# TODO —— TransHelper Prism 待办与已知问题

> 本文件记录**尚未完成**的事项与已知缺陷。已完成的任务见 `tasks.md`；设计决策见 `plan.md`；踩坑与交接见 `history.md`。

---

## 🔴 P0：后端域名被 GFW 拦（M3 完成后立刻做）

**现状**：前端在 `https://search.chengxi.moe`（自定义域，墙内可访问），但后端在
`https://transhelper-prism-backend.transprism.workers.dev`——**`*.workers.dev` 被 GFW 封锁**。

**后果**：墙内用户能打开前端页面，但**搜索请求全部失败**（前端 → workers.dev 的跨域请求被墙）。
也就是说墙内用户看到的是「页面能开、搜不出东西」。

**⚠️ 另一个被漏掉的问题（2026-09-09 侦察发现）**：**登录也会被墙**。
X OAuth 的回调地址是 `https://transhelper-prism-backend.transprism.workers.dev/api/v1/auth/oauth/x/callback`，
这是**浏览器顶层跳转**（不是 fetch）——墙内用户点登录后会在回调那一步被 GFW 拦死，永远登不上。
所以不能只代理 `/api/*`（那只解决搜索），**回调地址也必须挪到不被墙的域名上**。

**目标**：**前端与后端所有「浏览器会访问的地址」都走自有域名**，`workers.dev` 只允许出现在「服务端到服务端」的内部调用里：

| 方案 | 做法 | 备注 |
|---|---|---|
| **A（推荐）同源反代** | 给 Pages 加一个 **Pages Function**（`frontend/functions/api/[[path]].ts`）把 `/api/*` 反代到 Worker；前端 `NUXT_PUBLIC_API_BASE` 改成 `/api`（同源，无跨域） | 浏览器只与 `search.chengxi.moe` 通信；顺带消掉 CORS 与第三方域暴露。注意 Pages Functions 要正确透传 **POST body、SSE 流式响应、请求头**（SSE 必须不缓冲） |
| **B Worker 自定义域** | 给 Worker 绑自定义域，如 `api.chengxi.moe` 或 `search-api.transhelper.org`，前端指向它 | `chengxi.moe` 在**另一个 CF 账号**下 → 需在 Worker 所在账号建 custom domain，再到该账号配 DNS（跨账号 CNAME 有 1014/1016 坑，见 `history.md` 坑 17）；`transhelper.org` 若在 Worker 账号下则最省事 |
| **C 双管齐下** | A 做同源反代 + B 给 Worker 绑域名（供外部调用/运维） | 最稳，但工作量最大 |

**推荐落地方式（侦察后的具体方案）**：
1. `frontend/functions/api/[[path]].ts`：Pages Function 把 `/api/*` 反代到 Worker（透传 method/body/headers，**302 不跟随**（手动转发 `Location`），SSE 直接回传 `resp.body` 保持流式）。
2. Pages 环境变量 `NUXT_PUBLIC_API_BASE` 改成 **`/api`**（同源；`useApi` 本身就默认 `/api`）。
3. **`OAUTH_REDIRECT_URI` 改成 `https://search.chengxi.moe/api/v1/auth/oauth/x/callback`**（经同一反代打到 Worker）——
   并在 **X 开发者后台把这条加入 Redirect URI**（原 workers.dev 那条可留作本地/备用）。
4. 这样浏览器**只访问 `search.chengxi.moe`**：搜索、登录、AI 流式全部同源；`workers.dev` 仅用于 Pages Function ↔ Worker 的内部 fetch。

**改造清单（做的时候别漏）**：
1. `backend-cf/wrangler.jsonc` 的 `ALLOWED_ORIGINS`：若走 A，可收窄为前端域名（同源后其实不再需要跨域）
2. `frontend` 的 `NUXT_PUBLIC_API_BASE`（CF Pages 环境变量）：A → `/api`；B → 新域名 + `/api`
3. 登录回跳：`OAUTH_REDIRECT_URI`（X 后台登记的那个）与 `FRONTEND_BASE_URL` 跟随新域名调整
4. 若绑新域名，**X 开发者后台的 Redirect URI 必须同步改**（差一个字符就登录失败）
5. 改完实测：墙内网络（或 DoH 模拟）下 `search.chengxi.moe` 能**搜出结果 + 能完成登录 + 能看到 AI 流式**
6. 注意 Pages Function 的 `/api/*` 路由不要与 Pages 静态资源冲突（我们前端没有 `/api` 静态页，安全）；
   顺带确认 `_routes.json` 之类不需要额外配置（Functions 默认按文件路径生效）

**验收**：墙内用户打开前端 → 能正常搜索、能登录、能看 AI 总结。

---

## 🔴 P0.5：按 IP 分档限流 + 配额重置展示（设计稿已完成，待实施）

**设计稿见 [`plan-ratelimit.md`](./plan-ratelimit.md)**（含分档阈值、ASN 清单维护方式、D1 计数表、熔断、隐私与验收标准）。

实施顺序（详见该文档 §10）：
1. **R1（进行中）**：CF 边缘限流规则 —— zone `chengxi.moe` → Security → WAF → Rate limiting rules
   → `/api/v1/search` + 按 IP + 10 秒窗口 / 20 次 → Block 10 秒。**这层在边缘拦，连 Worker 成本都省。**
   ⚠️ 现状：规则已按此配置且状态设为「活动」，但 45 并发实测**没有出现 CF 的 403**（35 个 429 全是我们 Worker 的分档），
   说明边缘规则**尚未实际生效** —— 需确认规则状态/zone 是否正确，或免费版是否支持。**R3 已能独立兜住，R1 属成本优化。**
2. **R2**（你 + 我）：`PROXY_SHARED_SECRET` 在 **Pages env** 与 **Worker Secret** 两处设成同一个值（代码已就绪）。
3. **R3（分档计数 + 熔断）→ ✅ 已完成并线上验证（2026-09-09）**：
   - 分档判定与限额全对：`whoami` 显示 `tier=overseas`、`limit_per_min=10`、`llm_limit_per_min=2`、`resolved_by=proxy-trusted`；
   - **搜索档实测**：对齐窗口边界连打 13 次 → 前 10 次 200，**第 11 次 429** `{tier:"overseas",scope:"tier-limit"}`；
   - **LLM 档实测**：连打 14 次 `/chat` → 前 12 次放行，**第 13 次 429** `{tier:"logged_in"}`（= `ceil(60/5)`）；
   - `rate_counters` 表已建（apply-schema）；桶 key 为 HMAC 摘要、**表内无 IP 明文**；KV 限流已降级为 120/min 粗兜底。
4. **R4 突发与熔断 → ✅ 已完成并线上验证（2026-09-09）**
   - **修掉一个真 bug**：`rateGate` 原顺序是「封禁 → 分档 → 突发 → 全局」，分档被拒就提前返回，
     导致被拒请求永远进不到突发层；而突发阈值 20 次/10 秒（=120/分钟）高于所有档位（最高登录 60/分钟），
     **突发层等于死代码**（线上 40 并发实测 `burst` 恒为 0）。已改为「① 封禁 → ② 突发 → ③ 分档 → ④ 全局」。
   - 线上验证：25 并发（对齐分钟边界）→ `10×200 + 10×tier-limit + 4×burst + 1×blocked`，
     随后请求 `scope=blocked`、`retry_after≈54`、`X-RateLimit-Remaining: 0`。
   - ⚠️ 产品影响：现在 10 秒内打满 20 次会被**硬封 60 秒**（以前只是反复 429）。阈值 `BURST_PER_10S` 是 env，可按观感调。
5. **R5 观测 + 429 前端体验 → ✅ 已完成并线上验证（2026-09-09）**
   - 新增 `GET /api/v1/admin/ratelimit`（admin）：`tiers[] / scopes{search,llm,burst,global} / blocked_buckets / global{count,soft,hard,state} / limits`，
     **两条 SELECT、零写入**（单测断言"任何 run() 被调用即失败"）；`/admin` 页「用量」区已接入「分档限流观测」子块。
   - 搜索页 429：**不清空已有结果**、显示「请求过于频繁（当前档位：境外访客，10 次/分钟），请在 N 秒后重试」、
     按钮倒计时禁用、对 `overseas/unknown/cn_idc` 给出温和的登录引导；`quota-exceeded` 语义与 429 严格区分。
   - 实现注记：为区分 search/llm 桶，llm 行在 `rate_counters.tier` 列写 `llm:<档位>` 前缀（桶 key 不含该字符串，**计数器不重置、无 DDL**）。
4. ~~**R6.5 子域名委派**~~ → ❌ **已取消（2026-09-09）**：CF 的「添加站点」硬性拒绝子域名
   （`Please ensure you are providing the root domain and not any subdomains`），两个父域也都不在 transprism 账号；
   且委派要解决的「Worker 看真实 IP」已由 R2 信任链实现（实测 `resolved_by=proxy-trusted`）。
   反代开销实测可忽略（4.63s vs 4.62s）。详见 `plan-ratelimit.md` §8.1。
5. **第二前端域名 `search.transhelper.org`**（进行中）：走 **Pages 自定义域**（与 `search.chengxi.moe` 同样的跨账号方式），
   **不需要委派**。前端 `apiBase` 实测已是 `/api`（同源），所以第二个域名自动复用同一套 Pages Function 反代，零代码改动。
   做完需把该 origin 加进 `ALLOWED_ORIGINS`（否则从第二个域名发起的登录回跳会被拒）。
5. **R6（本条是你单独点名的 TODO）**：**5h 额度重置时间的展示与锚定方式**
   - 现状：窗口起点 = 每个用户**自己首次请求的时刻**（天然错峰，不存在全局统一重置挤爆）；
     但**会漂移**（过期后从"下次请求时刻"重算）→ 重置时刻不可预测，无法展示"还有多久重置"。
   - 计划：改为**按注册时间的网格锚定**（`window_start = 注册时间 + k×5h`），重置时刻固定可预测且仍错峰；
   - `/api/v1/me` 增加 `window_end` / `reset_at` / `reset_in_sec`；
   - 前端顶栏显示「x 小时后重置」，额度耗尽时提示「将于 x 小时后（HH:MM）恢复」。

## 🟡 P1：其它已知缺口

1. ~~**`/admin/usage` 的每账号 `requests` / `llm_tokens_*`**：需要 `key_usage` 加 `account_id` 列并接线~~ → **已完成（2026-09-09）**：`key_usage` 加 `account_id`、检索链路（embed/rerank）与 chat 都记账，线上实测 `requests=4 / llm_in=2281 / llm_out=491`。
2. ~~**X 授权范围可再收窄**~~ → **已实测，不可行（2026-09-09）**：把 scope 收窄成只 `users.read` 后，
   回调用 `/2/users/me` **返回 403**（前端显示 `登录失败（x-users-me-failed status=403）`）。
   结论：**X 的 `/2/users/me` 即使只取 id + username 也必须带 `tweet.read`**，已回滚并写进 `auth.ts` 注释与测试。
   授权页因此会显示"可查看你能查看的所有帖子"——已在登录页如实说明原因（我们确实不读帖子）。
   （`X_OAUTH_SCOPES` 这个 env 口子保留，便于将来 X 改行为后重试。）
3. **`ingest_runs` 记账未接**：摄取跑在 GitHub Actions，无 D1 访问权限；要接需给 Actions 加 CF API token。
4. **`KeyPoolDb.listActiveKeys` 未被消费**：跨 isolate 的 key 剔除不落库；当前真相源是 KV 禁用集（无 TTL，KV 被清空即回到「全部可用」）。
5. **`bigram_index` 表保留但不再使用**：回退检索已改为 Qdrant 全文索引（见 `plan.md` §5.4）。
6. **`/api/v1/admin/ingest/trigger`**：仅在升级 Workers Paid 后才有意义（免费版必 `exceededCpu`）。
7. **产出 0 chunk 的极短文件**：因无 payload 可存 `blob_sha`，每次增量都会被复核一遍（影响可忽略）。
8. **配额窗口重置无后台任务**：靠「读取时判断」，没有主动清理过期窗口的定时任务。

---

## 🟢 P2：M4（灰度与运营）未开

- 内测反馈收集与清零、key 挂单演练、压测复跑（20 条真实 query）
- 月账单（硅基流动 + CF）记入运营账
- 运营面板：`/admin` 的封禁/加额/审计目前是只读展示，真实操作走 admin 会话或运维 `ADMIN_API_KEY`
- 邮件绑定（T3.7）**已取消**（域名验证要花钱），如需再议

---

## ✅ 已完成（仅作对照，详见 `tasks.md`）

- M0 骨架 / M1 检索优化（rerank、KV 缓存、熔断、关键词回退、压测） / M2 数据管线（真·文件级增量、知识树、多 wiki）
- M3 账号与 LLM：X 登录（隐私只存 `sha256(x_id)`）、滚动 5h 配额（百分比口径）、限流、封禁+审计、
  AI 流式总结与多轮追问、自带模型（加密落库）、管理端 usage/keys/audit、匿名开放向量检索

---

_最后更新：2026-09-09_

---

## ✅ 技术债 1–4 已清除（2026-09-11）

| # | 项 | 状态 |
|---|---|---|
| 1 | `ingest_runs` 记账接上（Worker 代笔 + Actions 上报）| ✅ 线上验证：手动触发一轮，4 个 wiki 全部 `HTTP 200` 并落 D1 |
| 2 | 清掉死掉的 `bigram_index`（表 + 写入路径；**保留 `splitBigrams`**）| ✅ `DROP TABLE` 已在线执行 |
| 3 | 删掉从未被消费的 `KeyPoolDb.listActiveKeys?` | ✅ |
| 4 | `/admin/usage.requests` 改真实用户请求数（同条原子 UPDATE 自增）| ✅ 实测 0→1 |
| 5 | 极短文件不再每轮复核（`ingest_files.blob_sha` + 批量端点 + 统一判据）| ✅ 线上连跑两轮：第一轮登记、第二轮全部 `files=0` |

- 迁移：`apply-schema` 26 条语句（`tolerated` 仅预期的重复列、`failed` 空）
- GitHub Secret `ADMIN_API_KEY` 已配置
- 线上遗留一条**测试记录**：`ingest_runs` 里 `commit_sha=test0001` 那行（手工验证端点时写的，无删除端点，忽略即可）

### 待评审的新功能
- **用户可选返回条数（1–50，默认 10）+ 成本/过采样联动** → 设计稿：[`plan-topk.md`](./plan-topk.md)
  （需你先拍板两件事：纯检索是否按 n 线性计费；限流是按"请求数"还是按 n 反向缩放）

### 下一步候选
- **M4（灰度运营）← 计划：[`plan-m4.md`](./plan-m4.md)**
  - ✅ **W5 免责与 `/about` 已完成并上线**（2026-09-11）
  - ⏭ 接下来：W6 演练（key 挂单、LLM 全灭）、W2 压测复跑：内测反馈收集、**压测复跑**（顺便检验 20 次/10 秒硬封禁会不会误伤正常用户）、月账、运营面板
- 技术债 #7（ASN 清单按真实流量校准）—— 等有量再说
- 技术债 #6（配额窗口清理）已判定不需要

---

## 📌 2026-09-12 记录的待办（用户吃饭前提的 4 点 + 1 个待你操作）

### ⏳ 待你操作：把第二把 key 加进 CF Worker
第二把 key（`sk-qchy…`，**与第一把不同账号** ✓ 真正的封号冗余）已验证三种能力全部可用，
`.dev.vars` 与 **GitHub Secret `EMBED_POOL_KEYS`** 我已更新为 2 把；**CF 控制台这两项还需你手动加**：
`Workers & Pages → transhelper-prism-backend → Settings → Variables and Secrets`：
- `EMBED_POOL_KEYS` → 末尾追加 `,` + 新 key
- `LLM_POOL_KEYS` → 同样

改完告诉我 → 我验证 `/admin/keys` 各池 `configured=2` → watchdog ④ 转绿 → **并补做 W6 里唯一没做成的演练：真·自动换 key**
（下架 `llm-key-0`，看它自动切到 `llm-key-1` 而不是降级）。

### 1. key 管理方式要改（现在的逗号串密钥只能轮换、多了很麻烦）
**现状痛点**：`EMBED_POOL_KEYS` / `LLM_POOL_KEYS` 是 CF Secret，**写入后不可读回** →
每加一把 key 都要把整串重打一遍，加第 5 把时很容易出错。

**方案 A（推荐，成本最低）**：支持**按前缀扫描多个 env**——
代码把 `env` 里匹配 `^(EMBED|LLM|RERANK)_POOL_KEYS(_\d+)?$` 的变量全部收集起来拼成池。
- 加一把 key = 新建一个 `EMBED_POOL_KEYS_2` 密钥（**不用重打已有的**）
- 轮换/删除 = 只动那一个变量
- 无新表、无加密、约 1–2 小时

**方案 B（终态，可选）**：key 密文存 D1（AES-GCM，主密钥放 CF Secret，与"用户自定义模型"同一套做法），
`POST /admin/keys` 直接收明文 key 入库 → **加/删/轮换全在管理端完成，完全不碰控制台**。
- 代价：密钥材料进 D1（加密），多一层主密钥管理；需内存缓存避免每次选 key 都读 D1
- 建议：key 数量长到 5+ 把再做

### 2. 多 key 要做负载均衡（**现状确实没做**）
**实测代码事实**：`pickKey()` 的排序是 `inFlightCount ↑`，并列时 `cooldownUntil ↑`；
两把 key 都空闲且无冷却时**排序稳定 → 永远选第一把**。
所以顺序请求**全部打在 key#1 上**，第二把只在并发或 key#1 失败时才被用到。

**要改**：并列时用 **LRU（最久未用优先）** 作为次序（例如记 `lastUsedAt`，`a.lastUsedAt - b.lastUsedAt`）。
- 效果：顺序请求也能在两把 key / 两个账号之间**轮流**；
- **顺带降低封号风险**：把请求量摊到两个账号上，等于每个账号的用量减半（正对你担心的那件事）。

### 3. 「按钮位置」——待你说清楚是哪个按钮
你说"按钮位置，你等下提醒我就知道" → **我已记下**，回头我提醒你，你说明是哪个（
候选：搜索框下的「返回条数」选择器 / 免责弹窗的按钮 / `/about` 的返回按钮 / 结果区的某个入口）。

### 4. 未来形态：`chat.chengxi.moe`（LLM 驱动 RAG，而不是"先搜后总结"）
**现状**：先检索 → 再把片段喂给 LLM 总结（单向 RAG 管道），入口是搜索框。
**想要**：一个 chat 优先的站点，**由 LLM 自己决定何时/怎么调检索**（tool-calling 循环），多轮对话、带引用。
**要点（实施前需写 `plan-chat.md`）**：
- 检索作为工具暴露给模型（`search_wiki(query, corpora, top_k)`），模型自主决定调用次数；
- 复用现有栈（Qdrant + bge-m3 + rerank + 配额/限流），**但每轮可能触发多次检索** →
  配额与上游调用数都要按"每次工具调用"计，限流档位需重新标定（**每请求上游调用数会从 3–4 变成不可预知**）；
- 与防封号的关系：LLM 自主循环 = 上游调用数上升 → 需要**每会话的调用次数上限**与超时熔断；
- 可顺带考虑把检索暴露成 **MCP 工具**（旧版 transhelper 就有 MCP），让外部 agent 也能用；
- 域名/部署：同一 CF Pages 项目加自定义域即可（与 `search.transhelper.org` 同一套路）。
