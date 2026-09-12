# TODO —— 未完成事项与已知问题

> 本文件**只记还没做的**。已完成的任务见 `tasks.md`；设计决策见 `plan.md`；踩坑与交接见 `history.md`。
> _最后更新：2026-09-12_

---

## 🔴 需要你参与（我这边都已就绪，只差你一句话/一次操作）

### 1. M4-W1：小圈子内测招募 —— **唯一真正卡住的事**
- 计划与验收见 [`plan-m4.md`](./plan-m4.md) W1：招募 10–15 人、跑满 1 周、**≥5 名真实用户**、每条反馈有结论。
- 面向社群时请说清两件事：**墙内可用匿名检索**（`REQUIRE_LOGIN=0`，走完整向量检索）、**AI 伴读需登录且要能访问 x.com**（授权页在墙外）。
- 内测开始后我会：收集反馈 → 分类 → 修复/排期 → 回填验收。

### 2. UI 小项（都是可选项，你说做哪个我就做）
| 项 | 现状 | 可选的改法 |
|---|---|---|
| 折叠态结果卡不显示「查阅官方原文」 | 展开后才显示底部行（标题本身仍是外链） | 若想常驻，我加回底部行 |
| 抽屉浮动按钮位置 | `<1024px` 时 `fixed bottom-right`，可能压到页脚小字 | 加 safe-area 留白或上移 |
| 摘要折叠长度 | **120 字**（按最窄屏 4 行定）→ 桌面约 3 行 | 想桌面 4 行就把常量调 150 |
| AI 卡贴顶后不自动跟随 | 长总结生成时要自己滚到底 | 可改「生成中跟随、结束后回顶」 |
| 未登录窄屏顶栏 | `logo + 设置 + 更多 + 登录 + 主题`，360px 略挤 | 「设置」在 `<640px` 变纯图标 |
| 「管理后台」入口 | 按"顶栏只留设置+主题"搬进了账号菜单（仅管理员可见） | 如需回顶栏，说一声 |

---

## 🟡 有真实流量再做

### 3. 技术债 #7：ASN 清单按真实流量校准
- `backend-cf/src/data/cn-asn.ts` 的 CN 运营商/机房清单目前按公开资料填写。
- 等内测有量后：用 `/admin/ratelimit` 的档位分布 + 抽样 ASN 校准（**不存 ASN**，一次性采样）。
- 限流阈值本身已有实测结论：**突发保留 20 次/10 秒**（CN 家宽 30/分钟 = 5 次/10 秒，正常节奏碰不到）。

---

## 🟢 可选清理（我没擅自做，等你一句话）

| 项 | 说明 |
|---|---|
| 诊断代码 | `/admin/d1bench`（临时 D1/KV 基准端点）+ 响应里的 `handler_ms`/`gate_ms`/`gate_*_ms` 打点。**定位延迟时救过两次命**，留着有用；要干净可以摘 |
| 死配置 | `RATE_LIMIT_IP_PER_MIN` / `RATE_LIMIT_ACCOUNT_PER_MIN`（KV 限流器摘除后失效，声明保留仅为兼容旧 vars） |
| `provider_keys` 历史行 | 旧行 `pool='embed'/'llm'`、新行 `pool='keys'` → `/admin` 表格可能同时出现两种名字（纯展示，可手工 UPDATE 统一） |
| `ingest_runs` 测试行 | `commit_sha=test0001` 那行（手工验证端点时写的；无删除端点，忽略即可） |
| `/api/v1/admin/ingest/trigger` | 免费版必 `exceededCpu`，**升级 Workers Paid 后才有意义**（保留不动） |

---

## 🔵 未来形态（动手前先写 plan）

### 4. `chat.chengxi.moe`：LLM 驱动 RAG（而不是"先搜后总结"）
- **现状**：先检索 → 片段喂 LLM 总结（单向管道），入口是搜索框。
- **想要**：chat 优先的站点，**由 LLM 自己决定何时调用检索**（tool-calling 循环）、多轮、带引用。
- **要点（需先写 `plan-chat.md`）**：
  - 检索作为工具暴露（`search_wiki(query, corpora, top_k)`），模型自主决定调用次数；
  - 复用现有栈（Qdrant + bge-m3 + rerank + 配额/限流），**但每轮可能触发多次检索** →
    配额与上游调用数要按"每次工具调用"计，限流档位需重新标定（**每请求上游调用数从 3–4 变成不可预知**）；
  - 与防封号的关系：LLM 自主循环 = 上游调用数上升 → 需要**每会话调用次数上限**与超时熔断；
  - 可顺带把检索暴露成 **MCP 工具**（旧版 transhelper 就有 MCP），让外部 agent 也能用；
  - 域名/部署：同一 CF Pages 项目加自定义域即可（与 `search.transhelper.org` 同一套路）。

---

## ✅ 已完成（存档要点）

<details>
<summary><b>P0 域名/反代（已完成）</b>—— 墙内可用</summary>

- 起因：后端在 `*.workers.dev`（被墙）→ 墙内用户"页面能开、搜不出东西"；**登录回调**同样是浏览器顶层跳转，也会被拦。
- 落地（方案 A 同源反代 + 双域名）：`frontend/functions/api/[[path]].ts` 把 `/api/*` 反代到 Worker（透传 method/body/headers、302 不跟随并把相对 `Location` 改绝对、SSE 保持流式）；
  `NUXT_PUBLIC_API_BASE=/api`（同源）；`OAUTH_REDIRECT_URI=https://search.chengxi.moe/api/v1/auth/oauth/x/callback`（X 后台已登记）。
- 现役域名：主 `search.chengxi.moe`，冗余 `search.transhelper.org`（同一 Pages 项目）。
- 详见 `history.md` 坑 17/19/20 与 `frontend/functions/api/[[path]].ts` 注释。
</details>

<details>
<summary><b>P0.5 分档限流 + 配额重置展示（已完成）</b>—— 完整设计见 <code>plan-ratelimit.md</code></summary>

- 分档（次/分钟）：登录 60 / CN 家宽 30 / CN 其它 15 / **CN 机房 6** / 境外 10 / 未知 5；LLM = 档位 ÷5 向上取整。
- 突发 20 次/10 秒 → **硬封 60 秒**；全局匿名熔断 **软 300 / 硬 600**（软熔断时匿名降级为关键词回退）。
- 计数在 D1（HMAC 桶，**不存明文 IP**）；配额滚动 5h 窗口**按注册时间网格锚定**（重置时刻固定可预测），前端只显示百分比 + 「x 小时后重置」。
- 实测：突发层（25 并发 → 第 21 次 `burst` → 封 60s）与全局熔断（软/硬分级）均已**真触发验证**。
</details>

<details>
<summary><b>技术债 1–5（已完成）</b></summary>

1. `ingest_runs` 记账接上（Actions 上报 → Worker 代写 D1）✅ 线上验证 4 wiki 全 200 + 落库；
2. 死掉的 `bigram_index` 表已 DROP（保留 `splitBigrams` 供回退检索）✅；
3. 从未被消费的 `KeyPoolDb.listActiveKeys?` 已删 ✅；
4. `/admin/usage.requests` 改真实用户请求数（同条原子 UPDATE 自增）✅ 实测 0→1；
5. **极短文件（0 chunk）不再每轮复核**：`ingest_files.blob_sha` + 批量端点 + 判据统一 ✅ 线上连跑两轮，第二轮全部 `files=0`。
</details>

<details>
<summary><b>M4 灰度与运营 W2–W6（已完成）</b>—— 见 <code>plan-m4.md</code></summary>

- **W2 压测复跑**：rerank 代价 P50 +348ms；端到端延迟经两轮优化 **5.6s → 3.1s**（真凶是 KV 写 650ms/次，不是 D1 往返）。
- **W3 用量与上游风险监控**：`/admin/usage/summary` 上线 + watchdog 第 ⑥ 项盯每日上游调用量（上游长期免费，真风险是被判滥用封号）。
- **W4 运营面板与探活**：`watchdog.yml` 每 30 分钟 6 项检查、失败即发邮件；`/admin` 补摄取历史与 key 补货提示；含**故意失败演练**。
- **W5 免责与 `/about`**：医疗免责置顶 + 隐私逐条对齐实现 + 免责弹窗（可"以后不再提示"）+ 页脚常驻入口。
- **W6 应急演练**：key 挂单 / LLM 全灭等价路径 / 突发封禁 / 全局熔断 / 探活失败演练**均已真跑**。
- **W1 内测**：见上文「需要你参与」。
</details>

<details>
<summary><b>密钥池改造 + 多 key 负载均衡（已完成）</b>—— 见 <code>plan-keypool.md</code> 与 <code>history.md</code> 坑 49</summary>

- embedding/rerank/llm **合并为单池**；密钥按 `POOL_KEYS_<n>` 分变量（一把一个、数字递增），**加 key 只新建一个变量，永不重打已有**。
- **ref 由变量名派生**（`POOL_KEYS_3` → `pool-key-3`）：修掉旧实现按位置生成 ref（删中间一把会移位）的隐患。
- 禁用一把 key = **全能力禁用**；并修掉 `applyDenied` 逐个能力写入互相清空的真 bug。
- 并列时按 **LRU** 轮转（旧实现恒选第一把 → 顺序请求全打 key#1），请求摊到两个账号。
- **首次做成"真·自动换 key"演练**：下架 `pool-key-0` → 检索与 AI **零降级**（自动切到 `pool-key-1`）。
- 旧三变量（`EMBED_/LLM_/RERANK_POOL_KEYS`）已彻底删除，不留兼容代码。
</details>

<details>
<summary><b>前端检索页布局收束（已完成）</b>—— 用户多轮截图反馈</summary>

- 顶栏：额度 / 退出 / 外链 / 管理 收进**账号菜单**，常驻只留设置 + 主题。
- 搜索卡：**知识库芯片在左、「高级」按钮在右（同一行 justify-between）**；返回条数 + 精准重排收进「高级」折叠（默认收起，状态持久化）。
- 耗时默认只显示**总耗时**，点击展开拆解；结果卡正文默认折叠（摘要 4 行 + 展开全文 + 分数徽章）；「命中缓存」改弱徽章。
- AI 卡：标题「本次检索要点」、可收起并记住、默认**贴顶**（第一条要点完整可见）；`<1024px` 改**浮动按钮 + 底部抽屉**。
</details>

<details>
<summary><b>其它已完成 / 已判定不做</b></summary>

- 邮箱绑定（T3.7）**已取消**（域名验证要花钱），如需再议。
- X 授权范围收窄**已实测不可行**：`/2/users/me` 即使只取 id+username 也必须带 `tweet.read`（收窄后 403）。
- `/admin/usage` 的账号维度真值（`key_usage.account_id` 接线）✅
- 技术债 #6（配额窗口清理）**判定不需要**。
</details>
