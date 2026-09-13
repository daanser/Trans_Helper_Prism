# plan-chat.md —— transhelperprism·chat：LLM 自主 tool-calling 的对话式 RAG（设计稿）

> 状态：**设计稿，待评审**（2026-09-13）。评审通过后才拆任务实施；本文只描述设计，不含已落地的代码。
> **§2 的上游能力实测已完成并回填**（含三个推翻原假设的结论：tool calling 可用、思考强度做不了、TPM 是新的主风险）。
> 关联：`plan.md` §8.3/§8.4（LLM 功能范围与成本控制）、`plan-ratelimit.md`（分档限流）、`plan-keypool.md`（密钥池）、
> `plan-topk.md`（返回条数与计费）、`TODO.md` §4（本功能的原始需求）、`tmp.md`（用户提供的前端建议，已并入 §5）。
> 目标站点：`chat.chengxi.moe`（与 `search.chengxi.moe` **同一个 Pages 项目、同一个 Worker**）。
> 实施完成后需在 `history.md` 追加坑 51（agent 循环与子请求/CPU 预算的实测结论）。

---

## 0. 已定决策（与用户逐条确认）

| # | 议题 | 决定 | 理由 / 备注 |
|---|---|---|---|
| 1 | 仓库结构 | **留在本仓库，按层放**：后端 `backend-cf/src/agent/`，前端 `pages/chat.vue` + 顶栏模式切换 | 不建顶层 `chat/`，不拆仓库。90% 是复用（检索/密钥池/配额/限流/会话），且**防封号护栏与登录态必须单点**（token 存 localStorage、按 origin 隔离，拆站要登两次）|
| 2 | 与 Prism 的关系 | **同一产品的两种模式**，不是两个站；顶部「检索 \| 对话」分段切换 | 用户明确要求；两模式共享知识库选择、设置、账号、免责、主题 |
| 3 | 模式的技术表示 | **模式 = 路由**（`/` 检索、`/chat` 对话），不是 boolean | UI 约定 ①（单一数据源）：URL 可分享/可回退/刷新不丢 |
| 4 | 域名策略 | **定案 (b)：`chat.chengxi.moe` 整站 302 → `search.chengxi.moe/chat`**；不做第二个可用域 | 用户已拍板。保证"同一产品、一份登录态"（token 在 localStorage 按 origin 隔离，双域就要登两次，见 §3.4）|
| 5 | 匿名可用性 | **匿名可用 chat**，给 `ANON_CHAT_QUOTA_TOKENS` 默认 **6000** 加权 token 的额度（约 3 次典型会话 / 更多次简单提问） | 用户决定"没登录给三条次左右的额度，但按 token 记录"。窗口 5h，与登录配额对齐 |
| 6 | 匿名额度载体 | 复用 `rate_counters` 表新增 `scope="anonquota"`，**`count` 列语义改为"已消耗加权 token"** | 零新表、零新 secret；桶 key 仍是 HMAC 摘要（**不存明文 IP**）、判-扣同句不超卖。`block` scope 已借用 `count` 存时间戳，本项目有先例 |
| 7 | 匿名会话持久化 | **匿名会话不落库**（上下文由客户端回传，服务端校验并截断）；刷新即新会话 | `chat_sessions.account_id` 为 NOT NULL；更重要的是不制造"IP 派生伪身份"的长期痕迹。文案明说"登录后可保存对话记录" |
| 8 | 配额记账 | **逐次计费、每轮合并写账**：成本按每次检索/每次模型调用归因，但 D1 写账合并为"入口预占上界 + 轮末一次 batch"（§4.5.4 ①）| agent 循环总成本开工前不可知；预扣+退差额需要新事务语义。逐次计费复用现有原语，**而写账合并是为了子请求预算**（每轮 6 次上游调用各打一次 D1 = 18 条语句）|
| 9 | 工具暴露的参数 | `search_wiki` **只暴露 `query` 与可选 `corpora`，不暴露 `top_k`**；服务端固定 `top_k`（默认 8）+ 强制 rerank | 成本可预测；小模型选不好 k；与 UI 约定 ⑥（语义检索默认 8–10）一致 |
| 10 | 强制检索 | **首步用 `tool_choice` 强制调用一次 `search_wiki`**（任何问题，含「1+1」），prompt 里再写一遍；之后交给 `auto` | 用户决定"prompt 里写出用户问 1+1 这种无关问题都要搜"。用强制首检而不是"没调用再补一次"，逻辑更少、行为更确定（§4.1 a）|
| 11 | 无依据时的行为 | 检索为空/不相关 → **必须明说"没有找到依据"**，不得用模型自身知识作答；前端把无来源的回答**降权显示**并标「未检索到依据」 | 医疗题材硬约束（`plan.md` §8.3 第 1 条）。tmp.md 亦要求"默认引用强制可见" |
| 12 | 引用编号 | **会话级来源登记表**：来源首次出现时分配稳定 id（`s1`、`s2`…），模型输出沿用现有 `[来源3]` 格式 | 跨轮引用与"仅用已引用文献答"需要编号稳定；沿用 `extractCitationIndices` 少写一套解析 |
| 13 | 历史会话（D） | **做**：登录用户会话落库、左栏会话列表、可回看、可删除、自动标题 | 用户决定"最好是做"。`chat_sessions` 表已存在 |
| 14 | 思考强度选择 | **SiliconFlow 上不做**（实测）：唯一生效的旋钮是二值 `enable_thinking`，`thinking_budget`/`reasoning_effort` 均被上游静默忽略，而 `true` 档实测 14–131s → 20s 超时下不可用。**但切到 DeepSeek 后可做**（DS 的 `reasoning_effort` 是真实分级）| §2.5。保留现有 env 三态，**并把 `omit` 列为禁用值**（omit = 思考开启 = 必超时）；适配层按"关/低/中/高"的自家语义抽象，为将来留口 |
| 15 | 与现有「AI 伴读」的关系 | 检索页的 AI 伴读**保留不动**（先搜后总结、一次性）；它同时是 chat 的工具协议降级路径 | 对外功能名唯一（UI 约定 ②）：检索页仍叫「AI 伴读」，`/chat` 里的能力叫「对话」 |
| 16 | 单轮检索次数上界 | **3 次**（env `AGENT_TOOL_CALLS_PER_TURN`）| 用户要求"至少三次"。**不靠降上界解决**，靠 §4.5.4 的四条合并/削减手段把一轮从 ≈58 压到 ≈36 子请求；压完免费档够用，**暂不需要升 Workers Paid** |
| 17 | 工具协议 | **标准 `tool_calls`**，不做伪工具；循环判据 = `message.tool_calls` 是否存在（**不能用 `finish_reason`**）| 实测通过（非流式/流式/强制/多轮闭环），且模型会自主改写 query 重试（§2.1、§2.3 坑 1）|
| 18 | 思考参数 | **每次调用都显式传 `enable_thinking: false`**；不新增"深度思考"开关 | 不传=思考开启=33–45s；`false` 时 `reasoning_content` 字段完全不存在（§2.3 坑 3）|
| 19 | 输出 token 上限 | **为 chat 放开 `LLM_MAX_TOKENS` 的本地钳制**（`llm.ts:809` 现在是 `min(env, 800)`，env 只能调低）| chat 单条回答 300–800 字贴着 800 上限，且循环里 tool_call 的 `arguments` 同占额度 → 必须能调高（§4.5）|
| 20 | **默认模型（已确认）** | **默认 `Qwen/Qwen3.5-4B`**；`THUDM/GLM-4-9B-0414` 降为**非流式兜底** | 用户原指定 GLM，但实测其**流式 `tool_calls` 6/6 损坏**（§2.3 坑 7）+ 上下文仅 32768 + 空结果不重试 → **已向用户出示证据并获确认改回 Qwen**（2026-09-13）|
| 23 | **流式策略（已确认）** | **按 provider 能力位分流**：`supportsStreamingToolCalls=true`（Qwen 系列）→ **全程 SSE 流式**；`=false`（GLM）→ **混合模式**（工具决策轮非流式、作答轮 SSE） | 用户确认。代码里只有一个布尔位决定走哪条路，**不是两个模型两套代码**（§4.1.1）|
| 24 | **模型 failover 链** | `Qwen3.5-4B`（默认）→ `Qwen3.5-9B`（⏳ 待补测流式 FC，**首选备选**）→ `GLM-4-9B-0414`（**只能非流式**，最后兜底）| GLM 因流式 FC 坏 + 32k 上下文，不适合做第一备选；同系列的 Qwen3.5-9B 上下文与流式行为都可期。**TPM 429 时的切换顺序照此**（§4.5.1）|
| 22 | **为将来换 DeepSeek 留路** | LLM 层做成**薄适配器**（`agent/providers/`）：模型 id、思考控制字段、tool_calls 形状各自封装；换供应商 = 加一个适配器 + 改 env，**不改循环与工具** | 用户明确说"后面可能换 ds（DeepSeek），因为 9B 模型没竞争力，预设 prompt + RAG 也可能不如通用 AI"。既然会换，**接口边界现在就要留**，否则一次换模型就是一次重写（§4.10）|
| 21 | 检索次数纪律（prompt 侧）| 上界虽是 3 次（决策 16），但 **prompt 要求"优先 1 次就够"**、禁止重复同一 query、禁止为"更全面"追加检索 | §4.9 A。每一步都直接换算成子请求/TPM/等待时间，所以硬上限之外还要靠 prompt 主动收敛 |

---

## 1. 现状（代码实测，2026-09-13）

| 项 | 现状 | 对 chat 的影响 |
|---|---|---|
| LLM 通道 | `src/llm.ts`：硅基流动 OpenAI 兼容 `/v1/chat/completions`，SSE 流式，`summarize` / `streamSummary` 两个入口 | **只做"先搜后总结"**，没有 tool calling 代码 |
| 多轮追问 | `src/chat.ts` + `POST /api/v1/chat`：**非流式 JSON**、需登录、上限 10 轮、`history` 落库、复用 `initial_hits` 锚点 | 会话上下文机制可复用；但它是"锚定首轮 hits"的模型，不是"每轮可重新检索" |
| 登录门槛 | `/search/stream`（`index.ts:799` 起）与 `/chat`（`index.ts:928` 起）都**无条件用 `session.sub`** → **匿名用不了 LLM** | 决策 5 要求匿名可用 → 需要为匿名开一条不依赖 account 的记账路径 |
| 会话表 | `chat_sessions(id, account_id NOT NULL, model_id, corpora, round_count, initial_hits, history, created_at, updated_at)` | 匿名不落库（决策 7）；需要**新增来源登记与标题列**（§4.6） |
| 配额 | `quota.ts`：登录用户滚动 5h 窗口，`used_cost` = 加权 token；纯检索恒 **200**、rerank 按候选数 `ceil(200×候选/30)`、LLM 按真实 token | 匿名**当前完全没有配额**（只有限流）→ 决策 6 新建匿名额度桶 |
| 限流 | `ratecount.ts`：`consumeRateToken()` 每次请求**占 1 个名额**（`count = count + 1`），`scope` ∈ `search\|llm\|global\|burst\|block` | 需要"按权重扣"的兄弟函数（§4.4）；闸门口径要从"每请求一次"变成"**每次上游调用一次**" |
| 分档限流 | 登录 60 / CN 家宽 30 / CN 其它 15 / CN 机房 6 / 境外 10 / 未知 5（次/分钟）；LLM 档 = 档位 ÷ 5；突发 20 次/10 秒硬封 60s；全局匿名软 300 / 硬 600 | chat 一轮可能触发多次上游调用 → **必须按上游调用次数计**，否则护栏被绕过 |
| Key Pool | 单池 `POOL_KEYS_<n>`，LRU 轮转 + 禁用集 + `withKeyRetry` | agent 循环里每次上游调用都要走池与换 key（不能只在最外层换一次）|
| 上游成本 | 硅基流动 embedding/rerank/LLM **长期免费**；真风险是**账号被判滥用/封号** | 护栏的目的是**压上游调用频率与单请求调用数**，不是省钱（`plan-ratelimit.md` §1）|
| 现有 `enable_thinking` | `llm.ts` 已支持三态（`true` / `false` / 不传该字段），env `LLM_ENABLE_THINKING` | 思考强度的基础已有一半，缺"档位"语义（§2）|

### 关键风险判断（沿用 TODO 原话）

> 每请求上游调用数从 **3–4 变成不可预知**。

现有请求的上游调用数是**常量上界**：embed 恒 1、Qdrant **= 库数（≤4）**、rerank ≤ 2 批、LLM 恒 1 → **≤ 8**。
chat 的循环把它变成**变量**，因此本 plan 的核心不是"加一个对话框"，而是**给不可预知的调用数造一个确定的上界**（§4.5）。

---

## 2. 上游模型能力实测（A —— 已实测，2026-09-13）

> 实测对象：硅基流动中国站，模型 `Qwen/Qwen3.5-4B`（现有 `LLM_DEFAULT_MODEL`）。
> 方法：只读探测（curl 真实请求），未改任何代码/配置。key 全程未落盘未外发。

### 2.1 一句话结论

**能用标准 tool-calling 循环，不必退化为伪工具** —— 但**供应商与模型的选择被实测结果改写了**：

- ✅ `Qwen/Qwen3.5-4B`：非流式/流式/强制/多轮闭环全通过，流式分片规范，**空结果还会自主改写 query 重试**
  （真 agentic 行为），上下文 262k → **默认模型**。
- ❌ `THUDM/GLM-4-9B-0414`：非流式好、**流式 `tool_calls` 坏（6/6）**、上下文只有 32768、空结果不重试
  → **不能做默认**（见 §2.3 坑 7）。用户原本指定它，此处据实测建议改回 Qwen。
- ⚠️ 两条跨模型的硬约束：**思考模式在 20s 超时下不可用**（14–131s）；
  **`LLM_MAX_TOKENS = 800` 的本地硬顶与思考模式冲突到会产出空回答**。

### 2.2 能力矩阵

| 模型 | FC（非流式）| **FC（流式）** | `enable_thinking` 生效 | 上下文 / 输出 | 备注 |
|---|---|---|---|---|---|
| **`Qwen/Qwen3.5-4B`** ← **默认**（决策 20） | ✅ 1.2–2.4s | ✅ **0.75s，分片规范**（首片带 id/type/name，后续拼 arguments，拼出合法 JSON）| ✅ 真生效 | **262144** / max_tokens 131072 ✅ | 空结果会**自主改写 query 重试**；引用标注稳定 |
| `THUDM/GLM-4-9B-0414` ← 仅非流式兜底 | ✅ **0.54–0.91s（最快）** | ❌ **坏的（6/6 复现）** | ❌ 静默忽略（true/false 都 200、都无 reasoning）| **⚠️ 32768** / 默认输出 4096、max_tokens 16384 ✅ 32768 ❌400 | 见 §2.3 坑 7；空结果**不重试**；引用标注弱（强 prompt 下 3/4）|
| `Qwen/Qwen3.5-9B` | ✅ 1.07–2.14s | ⏳ 未测（**建议作为首选 failover 候选**）| ✅ 有 `reasoning_content` | 未测 | 换 DeepSeek 之前的候选 |
| `Qwen/Qwen3.5-35B-A3B` | ✅ 1.89s | ⏳ 未测 | ✅ | 未测 | 同上 |
| `Qwen/Qwen3-30B-A3B-Instruct-2507` | ✅ 1.72s | ⏳ 未测 | ❌ | 未测 | 同上 |
| `Qwen/Qwen2.5-7B-Instruct` | ⚠️ 0.77–1.09s，但 **3 次里 1 次不调工具直接作答** | 未测 | ❌ | 未测 | 不可靠，不用 |
| `Qwen/Qwen3-8B` | ✅ 但 28.8s（疑冷启动）| 未测 | ✅ 但 >120s | 未测 | 出局（`plan.md` §8.1 已判）|
| *将来：DeepSeek `deepseek-flash`* | ✅（文档）| ✅（文档：首片带 id/type/function，**标准形状**）| ✅ **`thinking:{type}` + `reasoning_effort: none/low/high/max`（真实分级）** | **1M** / 384K | 见 §2.7；**有真实可用的思考强度分级** |

### 2.3 六个必须写进代码的实测坑
1. **`finish_reason` 不可作判据。** 强制 `tool_choice` 时上游返回 `finish_reason: "stop"`，
   但 `message.tool_calls` **有值**。
   → **agent 循环的判据必须是 `message.tool_calls` 是否存在**，绝不能只看 `finish_reason`。
2. **流式 tool_calls 分片规则**：`id` / `function.name` **只在首片给出**，后续分片该字段为 `null` /
   空串，`function.arguments` 逐片拼接（实测 81 个 chunk）。
   → 累加器必须按 `index` 聚合、**只在首片取 id/name**、`arguments` 字符串拼接后一次性 `JSON.parse`。
   末片 `finish_reason: "tool_calls"`；`usage` 单独出现在 `choices: []` 的分片里（不传 `stream_options` 也给）。
3. **`enable_thinking` 不传 = 思考开启**（实测简单问句 33–45s，`enable_thinking: true` 更是 131s）。
   代码核实：`llm.ts` 的 `parseThinkingFlag()` 对未设置的 env **返回 `false`**（不是 `undefined`），
   所以**现有默认是安全的**；唯一的陷阱是有人把 `LLM_ENABLE_THINKING` 设成 `omit`（= 去掉字段 = 思考开启 = 必超时）。
   → **chat 必须始终显式传 `enable_thinking: false`，并把 `omit` 列为禁用值。**
4. **`LLM_MAX_TOKENS` 调不高。** 代码核实（`llm.ts:809`）：
   `maxTokens: Math.min(parsePositiveInt(e.LLM_MAX_TOKENS, 800), 800)` —— **env 只能调低，800 是硬顶**。
   后果有两个：① 思考模式下 800 token 会被 reasoning 吃光 → **final answer 返回空字符串**（实测 2/2）；
   ② chat 的单条回答（tmp.md 要求 300–800 字）**贴着上限**，且多步循环里 tool_call 的 `arguments` 也占额度。
   → **必须为 chat 放开这个本地钳制**（见 §4.5）。
5. **上游按模型有 TPM 限额**（不是只限 QPS）。爆量探测拿到原文：
   `{"code":50602,"message":"Request was rejected due to rate limiting. Details: TPM limit reached."}`
   —— 当时 GLM 正常、**4B 全 429**，约 100s 后恢复。
   → **一次提问 = 多次 LLM 调用 + 大块检索上下文，是最容易撞 TPM 的形态**；必须做 TPM 退避 + 换模型（见 §4.5）。
6. **静默异常要防御**：实测 1/9 次在 `enable_thinking:false` 下返回 `content: ""` + `finish_reason:"stop"`，
   整篇答案跑进了 `reasoning_content`。代码核实：`extractDeltaContent()` 只读 `delta.content` /
   `message.content`，**完全忽略 `reasoning_content`** → 这种情况现在会静默产出空回答。
   → 循环判据加一条：**`content` 为空但 `reasoning_content` 非空 → 视为空回答，重试或降级**（§6）。
7. 🔴 **`THUDM/GLM-4-9B-0414` 的流式 `tool_calls` 是坏的（6/6 复现）** —— 这是"默认模型不能选 GLM"的
   决定性证据（决策 20）。完整 schema 与极简 schema 各跑 3 次，逐字节一致地坏：

   ```
   {"delta":{"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":"","arguments":"search"}}]}}
   {"delta":{"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":"","arguments":"_w"}}]}}
   {"delta":{"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":"","arguments":"iki"}}]}}
   {"delta":{"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":"","arguments":"\n"}}]}}
   {"delta":{"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":"","arguments":"\"}"}}]}}
   → 拼出 arguments = `search_wiki\n"}` → JSON_VALID=NO
   ```

   即**模型把函数名+换行塞进了 `arguments`，真正的查询参数根本没发出来**，`id` 恒 `null`、`name` 恒 `""`。
   **无法靠"剥掉前缀"抢救**（参数不存在，不是格式问题）。对照 `Qwen/Qwen3.5-4B` 3/3 规范。
   → **GLM 只能用于非流式的工具决策轮**；**不要**为它写"解析流式伪 tool_call"的兼容层。
   → 无法区分是硅基流动侧集成问题还是模型自身问题（无第二家托管渠道可对照）。

**⚠️ 两个模型的行为差异（写代码时必须两种都兼容）**

| 行为 | `Qwen/Qwen3.5-4B` | `THUDM/GLM-4-9B-0414` |
|---|---|---|
| 强制 `tool_choice` 的 `finish_reason` | **`"stop"`**（但 `tool_calls` 有值）| **`"tool_calls"`** |
| 流式首片 | 带 `id` / `type` / `function.name` | **都不带**（`id:null`、`name:""`）|
| 流式 `usage` | 只在末尾 `choices:[]` 片给一次 | **每个 chunk 都带累积 `usage`** |
| 空结果是否自主改写重试 | ✅ 会（`{"query":"跨性别 激素替代疗法 常用方案"}`）| ❌ **不会**，直接放弃并说"很抱歉没找到" |
| 引用标注遵守率 | 强 prompt 下 1/1 标全 | 弱 prompt 2/4、强 prompt 3/4 → **需服务端后处理校验** |
| 上下文 | **262144** | **⚠️ 32768**（多步 RAG 每轮堆片段，几轮就满）|
| 答案长度倾向 | 闭环 500–800 字 | 闭环 ~300–400 字（更短更浅）|
| step-1 延迟 / 吞吐 | 0.69–2.42s；34–45 tok/s | 0.51–0.55s（更快）；36.9 tok/s（同档）|

→ **要固化的三条**：① 判据统一为 `message.tool_calls` 存在性（两模型都成立）；
② 流式解析要能同时吃"首片带 id"与"首片不带 id"；③ **空结果改写重试必须由服务端实现**（不能依赖模型，GLM 不会做）。

### 2.4 延迟与 token 实测

| 配置 | `time_total` | completion_tokens |
|---|---|---|
| `enable_thinking=false` 简单问句 | 2.45s | 37 |
| `enable_thinking=false` 数学推理题 | 18.15 / 18.02s | 657 / 573 |
| 不传该字段 简单问句 | 32.99s | 1295 |
| 不传该字段 数学题 | 44.84 / 35.48s | 1708 / 2673 |
| `enable_thinking=true` 简单问句 | **130.73s** | 4418 |
| `enable_thinking=true` 数学题 | 55.85 / 60.88s | 2483 / 2272 |
| `enable_thinking=true` + `max_tokens=800` | 17.90s | 800 → **`finish_reason:"length"`、content 为空** |
| **agent step-1（system + tools）** | **1.94 / 1.16 / 2.42s** | — |
| **闭环（含 605 字工具结果）** | **1.66–8.42s** | 196–905 |

**吞吐 ≈ 34–45 tok/s** → `20s × 40 ≈ 800 tok`，正好等于现有硬上限（这也是坑 4 的由来）。

### 2.5 思考强度：**做不了分级**（决策 14 因此改变）

关键控制实验：**传一个完全瞎编的参数 `totally_bogus_param_xyz` 也返回 HTTP 200**
→ **上游静默忽略未知字段，200 不代表参数被支持**。据此逐个排除：

| 候选参数 | 实测 | 判定 |
|---|---|---|
| `thinking_budget` = 128 / 1024 / 4096 | 传 128 仍产出 2527 completion tokens / 5374 字推理（128 预算不可能产 2527 token）；三档与不传无单调关系 | **被静默忽略** |
| `reasoning_effort` = low / high | 各 3 次：low 中位 4349 字、high 中位 4941 字、不传 3386–5807 字，**分布完全重叠** | **无可靠效果** |

→ **唯一真实生效的旋钮是二值的 `enable_thinking`。** 而它的 `true` 档在 20s 超时下不可用（14–131s），
要真开需要 ≥90s（建议 180s）超时，且与 800 token 上限冲突。
**结论：SiliconFlow 这边不做"思考强度选择"这个前端功能**（既没有可选的档位，唯一一档还会把延迟推到分钟级）。
保留现有 env 三态即可，并显式禁用 `omit`。

> 🔄 **但这条结论只对硅基流动成立**：实测调研发现 **DeepSeek 的 `reasoning_effort`
  （`none` / `low` / `high` / `max`）是真实生效的分级**（§2.7①）。所以**如果将来切到 DeepSeek，
  「思考强度选择」就可以做了** —— 决策 14 应在换供应商时重新评估，而不是永久关闭。
  这也说明适配层（决策 22）必须把"思考控制"抽象成**我们自己的语义**（关 / 低 / 中 / 高），
  由各供应商适配器翻译，否则将来做不了这个功能。

### 2.6 未测出 / 不能断言的（不编造）

- **"免费"无法从 API 验证**：`/v1/models` 只返回 `created/id/object/owned_by`，无价格字段；
  `cloud.siliconflow.cn` 定价接口 307 跳登录。§2.2 里除现用模型外的候选只按"非 Pro 前缀"推断，**未证实**。
- `Qwen3.5-4B` 精确上下文上限未找到（只确认 ≥233,352 tok）。
- **并行工具调用（一条消息多个 `tool_calls`）从未出现** → 实现要能容错但不能依赖它。
- 备选模型的**流式 FC 未测**（GLM 的已测——坏；`Qwen3.5-9B` / `35B-A3B` / `Qwen3-30B-A3B` 仍未测）。
- 并行工具调用：GLM 与 Qwen **全程都只返回 1 个 `tool_calls`**，未测多调用。
- GLM 流式 FC 的坏是**硅基流动侧集成问题**还是**模型自身问题**，无法区分（无第二家托管渠道对照）；
  且 GLM 只在 `tool_calls` 上坏，**纯文本流式对话是正常的**。
- 引用遵守率样本偏小（GLM：弱 prompt 2/4、强 prompt 3/4），需更大样本才能定服务端校验的严格度。

### 2.7 换 DeepSeek 的事实调研（官方文档，无 key 未实测）

> 用户计划后续替换（"9B 模型没竞争力"）。以下全部来自官方文档，**标注来源**；
> 凡是文档没写的，一律写"未查到"，不推测 API 行为。
> 来源：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)、
> [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)、
> [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)、
> [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion)、
> [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit)、
> [Terms of Use](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)、
> [Open Platform ToS](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)

**① 好消息：三件事都比硅基流动强**

| 维度 | 结论 |
|---|---|
| 模型 id | 在售 enum 只有 **`deepseek-flash`** 与 **`deepseek-v4-pro`**；旧名 `deepseek-v4-flash` 等已退役但仍被接受（转由 V4.1-Flash 承载）|
| 兼容性 | **OpenAI 兼容 ✓**，base_url `https://api.deepseek.com`，标准 Bearer |
| Tool calling | ✅ 两模型均支持；流式形状是**标准 OpenAI**（官方原文："The first chunk of each tool call carries the id, type and function fields; subsequent chunks only carry the function arguments."）→ **和 Qwen 一样规范，不是 GLM 那种坏的** |
| **思考强度** | 🔴 **真实可用的分级**：`thinking:{"type":"enabled"/"disabled"}`（默认 enabled、默认 effort=high）+ **`reasoning_effort: none \| low \| high \| max`**，官方给了真实映射表 → **如果切到 DS，「思考强度选择」这个功能就能做了**（决策 14 可重新评估）|
| 上下文 / 输出 | **1M / 384K** |
| 价格（每 1M token，off-peak/peak）| `deepseek-flash`：输入缓存命中 $0.003/$0.006、未命中 $0.15/$0.30、**输出 $0.6/$1.2** → **不再是免费**，配额口径要能容纳真花钱（§4.10）|

**② 必须做适配层（决策 22）的直接证据**：DS 用的是 `thinking` + `reasoning_effort`，
**文档全文没有 `enable_thinking`** → 传了会 400 还是被忽略**无法从文档确定，必须拿 key 实测**。
**绝不能把 `enable_thinking` 无条件透传。**

**③ 三条 DS 独有的坑（切之前必须处理）**

1. **思考模式下 `tool_choice: "required"` 或指定具体函数会 400** → 我们"首步强制检索"的设计在 DS 上
   必须改成 `auto` + prompt 约束，或先关思考再强制（适配层要提供这个切换）。
2. **带 `tools` 时，历史里的 `reasoning_content` 必须全量回传，否则 400** → 会话历史存储结构要能装它。
3. **Chat Completions 不支持会话中途插入 tool call 消息**（要插得用 Anthropic / Responses API）
   → 我们的 `/agent/*` 若是"每轮独立请求 + 全量历史回放"，需要确认历史形状里 assistant(tool_calls) 的位置合法。

**④ 合规评估（只列官方条款要点，不臆测）**

官方文档**没有**专门禁止跨性别/性少数医疗信息的条款。最接近的四条：

- **Terms of Use §3.4**：不得生成「discriminatory … based on race, gender, **sexuality**, religion…」的内容或 chatbot
  → 针对**输出具有歧视性**，不是禁止讨论该题材；
- **§3.6(2)**：不得用于「dangerous purposes that may have serious harmful impacts on **physical health**, psychology, society…」
  → 医疗题材需注意措辞（我们已有"以原文与医生意见为准"的免责路径）；
- **§3.3**：DeepSeek 有权用技术手段审查用户行为，包括**风险过滤机制**与违法内容特征库；
- **Open Platform ToS §7.2**：若 DS **单方认定**你或终端用户违反条款，**可不经事先通知**警告、限制功能、
  限制/暂停使用、**封号**、禁止重新注册、删除内容。

→ **判断**：题材本身未被点名禁止，但 **§7.2「单方认定 + 无事先通知即可封号」是真实运营风险**，
与 `plan.md` §8.5 已识别的"灰产 key 买定离手"属**同类失效模式** → 需要同样的多供应商/多 key 逃生通道，
且**不能在切换后才发现拒答**（§7 把"拒答率抽样"列为切换前置）。

---

## 3. 架构与仓库结构

### 3.1 结构（决策 1）

```
backend-cf/
  src/
    agent/                      ← 新增：chat 的后端
      loop.ts                   agent 循环（模型 ⇄ 工具，步数/超时/预算三重上界）
      tools.ts                  工具定义与执行体（search_wiki；执行体直接调 search.ts）
      prompt.ts                 chat 专用 system prompt（首检强制、检索纪律、输出纪律）
      sources.ts                会话级来源登记表（决策 12）
      budget.ts                 每轮/每会话调用预算 + 子请求计数打点 + 提前收尾
      agentsessions.ts          会话 CRUD + 标题（决策 13）
      providers/                ← 薄模型适配层（决策 22：为换 DeepSeek 留路）
        types.ts                归一化接口：{content, reasoning, toolCalls, finishReason, usage, errorClass}
        siliconflow.ts          硅基流动（Qwen / GLM 差异）、思考字段翻译、错误码归一化
        index.ts                按 env 选供应商 + 模型 failover 链
    index.ts                    ← 新增一组 /api/v1/agent/* 路由（不改现有路由）
frontend/
  pages/chat.vue                ← 新增：对话页（/chat）
  components/ModeToggle.vue     ← 新增：顶栏「检索 | 对话」
  components/chat/              ← 新增：对话流、引用卡、过程条、输入区、会话列表
  composables/useChat.ts        ← 新增：SSE 消费 + 会话状态
```

**复用而不重写**：`search.ts`（检索编排）、`embeddings.ts` / `rerank.ts`、`keypool.ts` / `keyadmin.ts`、
`quota.ts`、`ratelimit.ts` / `ratecount.ts` / `tiers.ts`、`searchcache.ts`、`llm.ts`（流式与换 key）、
`chat.ts`（会话上下文读写）、`custommodel.ts`（自带模型）、`db/schema.sql`。

### 3.2 部署（零新增基础设施）

- **同一个 Worker**（`transhelper-prism-backend`）新增 `/api/v1/agent/*` 路由 → 自动获得现有 L1/L2 限流、密钥池、D1、KV。
- **同一个 Pages 项目**加自定义域 `chat.chengxi.moe`（照抄 `search.transhelper.org` 的双域名套路）。
- `/api/*` 同源反代（`frontend/functions/api/[[path]].ts`）**不需要改**：SSE 已经保持流式透传。

### 3.3 数据流
```
浏览器 /chat ──SSE──▶ Worker /api/v1/agent/chat
                        │
                        ├─ 预检：限流 + 配额最低预算 + 匿名额度
                        ├─ agent 循环（上界：步数 / 工具调用数 / 墙钟超时 / 子请求预算）
                        │    ├─ LLM 调用（流式，逐次扣 LLM 配额）
                        │    └─ 工具调用 search_wiki（内部就是现有搜索链路，逐次扣检索配额）
                        └─ 流内事件：session / trace / sources / delta / usage / done / error
```

### 3.4 ⚠️ 双域名与登录态（代码实测发现的真问题）

**token 存 localStorage，按 origin 隔离** —— 在 `search.chengxi.moe` 登录，`chat.chengxi.moe` **不会自动登录**。
两种模式是"同一产品"，但两个域名就是两份登录态，用户会以为"登录坏了"。三条路：

| 方案 | 做法 | 登录态 | 代价 |
|---|---|---|---|
| (a) 只用一个域名 | 不做 chat 域；`search.chengxi.moe/chat` | ✅ 天然一份 | 少了 chat 域的牌子 |
| **(b) chat 域只做跳转 —— 已定案** | `chat.chengxi.moe` 整站 302 → `search.chengxi.moe/chat` | ✅ 一份（登录始终发生在 search 域）| 地址栏会变成 search 域 |
| (c) 两个域名都完整可用 | 必须改 Worker 的 `ALLOWED_ORIGINS` 加 `https://chat.chengxi.moe`（否则登录回跳被 `sanitizeRedirect` 丢弃 → token 落到 search 域，chat 域仍是未登录）| ❌ 用户要在两边各登一次 | 无跨域 SSO 手段（无共享 cookie 域）|

**（c）的代码依据**（留档，将来若改主意）：`auth.ts` 的 `sanitizeRedirect()` 只放行 `ALLOWED_ORIGINS` 里的源或
`frontendBase`；`useAuth.ts` 已传**绝对**回跳地址（`window.location.origin + pathname`），所以域名白名单是唯一缺口。
注意若走 (c)，`chat.chengxi.moe` 的页面**必须传绝对 redirect**——传相对路径会被 `new URL(raw, frontendBase)` 解析成
**search 域**，登录态就丢了（`auth.ts` 注释里记着同类坑）。

> **已定案 (b)**：保住 `chat.chengxi.moe` 这个牌子可用于对外分享，又不引入"两份登录态"这个必然让用户以为"登录坏了"的状态。
> 落地方式：Pages 上 `chat.chengxi.moe` 用 `_redirects`（或页面级 302）整站跳到 `search.chengxi.moe/chat` +
> 路径前缀透传；**前端代码零改动**（不需要客户端 host 判断插件）。
> Worker 侧 `ALLOWED_ORIGINS` **无需改动**，`OAUTH_REDIRECT_URI` 也**保持不变**。

---

## 4. 后端设计

### 4.1 agent 循环（`agent/loop.ts`）

一轮对话 = 一个 SSE 长连接；循环骨架：

```
输入：message、corpora、session_id?、options{仅用已引用/重新检索}
① 预检（**一次 `db.batch`**，§4.5.4 ①）：限流按上界占位 → 会话归属 → 剩余额度 ≥ 最低预算
② 组装 messages：system(chat prompt + 来源清单) + history(截断) + user(message)
③ 循环 step = 1..STEP_MAX：
     a. **step 1 强制检索**：`tool_choice = {type:"function", function:{name:"search_wiki"}}`
        —— 保证"任何问题都先查一次"（§4.9 A1），省掉"没调用再补一次"的保险逻辑
     b. step ≥ 2：`tool_choice = "auto"`，让模型自己决定是继续查还是作答
     c. 调用 LLM（流式）→ 边流边把正文 delta 推给前端；同时按 index 收集 tool_calls
     d. **判据：`message.tool_calls` 是否存在**（**不看 `finish_reason`**，§4.2.1）
     e. 若无 tool_calls → 这是最终回答，跳出循环
     f. 若有 tool_calls → 逐个执行（受 `AGENT_TOOL_CALLS_PER_TURN` 上界约束），结果作为 tool 消息回灌
        · 每次执行前：检查剩余额度/步数/墙钟预算，不足则**提前收尾**（见 ④）
④ 收尾：把已获得的资料交给模型做最后一次"仅基于已有片段作答"，
        或（模型不可用/超预算）直接把已命中的来源卡返回并附提示
⑤ 结算（**一次 `db.batch`**）：配额按实际用量写账 + key 用量 + `requests` 自增
⑥ 落库：登录用户写 chat_sessions（history + 来源登记 + 标题）；匿名不落库
```

**典型步数 = 2**（1 次强制检索 → 1 次作答）；模型自己追加检索时才会到 3–4 步。上界 4 步 / 3 次检索。

#### 4.1.1 流式策略：按 provider 能力位分流（决策 23，已确认）

GLM 的流式 `tool_calls` 坏了（§2.3 坑 7），但前端必须能"正在检索…" + 正文逐字。方案不是两套代码，
而是**一个能力位**：

```ts
interface LlmProvider {
  /** 流式响应里能否可靠拿到 tool_calls（Qwen=true，GLM=false） */
  readonly supportsStreamingToolCalls: boolean
  // ...
}
```

| 能力位 | 路径 | 适用 |
|---|---|---|
| `true` | **全程 SSE 流式**：每一步都流式，边流边收集 `tool_calls`（累加器按 `index` 聚合，首片取 id/name）| `Qwen/Qwen3.5-4B`（默认）、`Qwen3.5-9B` 等 Qwen 系列 |
| `false` | **混合模式**：工具决策轮走**非流式**拿 `tool_calls`；**最终作答轮**走 SSE 流式 | `THUDM/GLM-4-9B-0414` |

**混合模式怎么判断"这一轮是作答轮"**（不能靠猜）—— 用确定性规则：
- 工具调用次数已达上界（`AGENT_TOOL_CALLS_PER_TURN`）→ **后续必为作答轮** → 流式；
- 用户勾了"仅用已引用文献答" → 不检索 → 流式；
- 其余情况 → 非流式（保守）；拿到响应后若**没有** `tool_calls`，说明它就是最终回答，
  此时**把它按句子切片补发 `delta`**（正文已完整拿到，属"伪流式"）。

> 默认模型是 Qwen（走全程流式，体验最好），所以**混合模式只会在 TPM 降级到 GLM 时才启用** ——
> 影响面小，但必须有这条路径，否则 GLM 兜底时功能直接不可用。

#### 4.1.2 空结果的改写重试必须由服务端做

实测：**GLM 不会自主改写 query**（直接回"很抱歉没找到"），Qwen 会。为了两个模型行为一致、
且**不改 prompt 就能保证兜底**：

- 工具执行后若 **0 命中**（或全部命中都低于相似度阈值）→ **服务端自己做一次 query 改写**并再检索一次
  （改写策略：去掉疑问词/语气词、抽取核心名词、可选追加"跨性别"等域词；由**规则**实现，不再调一次 LLM
  —— 调 LLM 只多花一个模型步，不如规则便宜且确定）。
- **上限 1 次**（env `AGENT_EMPTY_RETRY=1`）；仍为空 → 回 `search-empty`，按决策 11 明说没有依据。
- 这次重试**计入配额与子请求预算**（是第 2 次检索），但**不计入"模型工具调用次数"**（不是模型的决定）。
- 顺带的好处：**比让模型重试更省** —— 模型重试要 1 次模型调用 + 1 次检索，服务端重试只要 1 次检索。

#### 4.1.3 引用标注要服务端校验（不能只靠 prompt）

实测引用遵守率不稳定（GLM 弱 prompt 2/4、强 prompt 3/4；Qwen 强 prompt 1/1）。
所以**服务端做后处理校验**，前端只信服务端：

1. 正文生成完 → 用现有 `extractCitationIndices()` 抽出所有 `[来源n]`；
2. 落在会话来源登记表（§4.8）之外的编号 → **判定为编造引用**，从正文里移除并计一次 warning；
3. 全文一个引用都没有，但本轮检索有命中 → 前端按决策 11 **降权显示 + 标「未标注来源」**
   （不阻断、不改写模型输出，只做标记 —— 避免服务端"替模型说话"）。

**为什么是"提前收尾"而不是"报错退出"**：用户已经看到流式正文了，报错会显得像崩了；
且医疗场景下"给出已查到的来源 + 说明为何没继续"比"失败"有用。

### 4.2 工具定义（`agent/tools.ts`）

一期只暴露**一个工具**（调用数越少，成本与因果链越清楚）：

```jsonc
{
  "name": "search_wiki",
  "description": "在四部中文性别/性少数 wiki（MtF / FtM / RLE / Mio）中做语义检索，返回最相关的原文片段。任何问题都必须先调用本工具，包括常识问题与闲聊。",
  "parameters": {
    "type": "object",
    "properties": {
      "query":   { "type": "string", "description": "检索词。可以是改写后的关键词，不必与用户原话相同。" },
      "corpora": { "type": "array", "items": { "type": "string" },
                   "description": "限定知识库；省略表示用户当前勾选的全部。" }
    },
    "required": ["query"]
  }
}
```

- **不暴露 `top_k`**（决策 9）：服务端固定 `AGENT_TOOL_TOP_K`（默认 8），强制开 rerank → 单次工具调用成本恒定 = `200 + rerankCost(8)`。
- **执行体直接调用 `search.ts` 的编排函数**，不新开检索路径 → 缓存（KV 1h）、降级（Qdrant 全文回退）、
  timings、换 key 全部自动继承。已核实可这么调（`src/search.ts:200`、`src/types.ts:144`）：

  ```ts
  await runSearch(
    { query, corpora, top_k: AGENT_TOOL_TOP_K, use_reranker: true /* use_llm 保持缺省 false */ },
    env,
  )
  ```

  `use_llm` 必须**保持关闭**：检索只负责取片段，总结由 agent 循环里的模型调用完成（否则一次工具调用会带出两次 LLM）。
- **工具结果形状**：模型收到的是带稳定来源 id 的片段文本（`【来源3】<标题> · <知识库>` + 截断正文 ≤600 字，
  沿用 `LLM_HIT_MAX_CHARS`）；前端收到的是结构化来源卡（§4.7）。**同一来源 id 在两侧一致**。
- 一期不做第二个工具。二期可加 `read_document(doc_id)`（读取某命中文件的更多正文，无 embedding、成本极低）
  —— 但那属于 M3，见 §7。

#### 4.2.1 协议实现细节（全部来自 §2 实测，不是推测）

| 事项 | 实测结论 | 实现要求 |
|---|---|---|
| **循环判据** | 强制 `tool_choice` 时：**Qwen 返回 `finish_reason:"stop"`、GLM 返回 `"tool_calls"`，但两者 `message.tool_calls` 都有值** | **判据只看 `message.tool_calls` 是否存在**（两模型都成立，可固化成一条规则）；`finish_reason` 最多作为诊断字段 |
| **流式 tool_calls** | **Qwen**：首片带 `id`/`type`/`name`，后续片为 `null`/空串，`arguments` 逐片拼接（3/3 正确）。**GLM**：`id` 恒 `null`、`name` 恒 `""`，函数名被塞进 `arguments` → **6/6 损坏，不可用** | 累加器按 `index` 聚合、**首片若有 id/name 就取**（兼容 GLM 首片不带的情况）；`arguments` 拼接后**一次性 `JSON.parse`**；解析失败 → **视为无效调用**，不"剥前缀"抢救。GLM 走 §4.1.1 的非流式决策轮 |
| **流式 usage** | **Qwen**：只在末尾 `choices: []` 片给一次。**GLM**：**每个 chunk 都带累积 usage** | usage 提取要能同时吃两种；**不能假设 `choices[0]` 一定存在**（现有 `extractDeltaContent` 用 `choices?.[0]` 是安全的，但 usage 提取要单独写）|
| **多轮回灌** | `assistant(tool_calls)` + `role:"tool"`(`tool_call_id`) 标准形状可用；605 字中文结果不崩（两模型都通过）| 用标准形状，不自造协议 |
| **tool_call_id 格式** | Qwen 流式是 `call_…`、非流式是 `chatcmpl-tool-…`，**两种回传都正常**；GLM 非流式正常 | 不要对 id 格式做正则校验 |
| **并行工具调用** | **全程从未出现**（GLM/Qwen 都只返回 1 个）| 代码要能处理 `tool_calls.length > 1`（逐个执行、逐个回灌），但**不依赖**它发生 |
| **长 system prompt + tools** | 2060 prompt tokens 的 system prompt 同时带 `tools` 正常工作（1.56s）| prompt 长度不是约束；但 prompt tokens 计入 TPM（见 §4.5）|

### 4.3 配额口径（决策 8 + §4.5.4 ① 的记账合并）

**"逐次计费、每轮合并写账"** —— 这是 §4.5.4 ① 的直接结果：
- **计费口径仍是逐次**（每次检索、每次模型调用各自记一笔，成本可归因、可对账）；
- **写账口径合并为每轮一次**（入口预占上界 + 轮末一次结算），否则 6 次上游调用 × 每次 3 条语句的
  D1 往返会把子请求预算吃光。

| 动作 | 成本 | 记账时点 |
|---|---|---|
| 一次 `search_wiki`（含 embed + Qdrant + rerank） | `computeQuotaCost({search:true, rerank:true, topK:AGENT_TOOL_TOP_K})` = 200 + rerankCost(8) ≈ **360** | 轮末 batch 按实际次数累加 |
| 一次 LLM 调用（每一步，含最终回答） | 真实 token（`usage.tokens_in + tokens_out`），流结束后累计 | 轮末 batch |
| 匿名 | 同上，但落在 `scope="anonquota"` 的匿名桶 | 同上 |

- **入口预扣上界**：进入循环前按"3 次检索 + 4 步生成"的**最坏成本**判一次额度（`db.batch` 内判-扣），
  不够就 402 风格的可读提示（不入循环）。**轮末只补不退**（保守，宁可多算）。
- **循环内不足**：不发起新的工具调用/模型调用，转入 §4.1 ④ 提前收尾。
- **`requests` 计数**：一趟对话计 **1 次请求**（不是每次上游调用计 1 次），保持 `/admin/usage` 的"真实用户请求数"语义。
- **不新增"按次"展示**：前端**不显示"还剩 3 次"**这种假动作计数，只显示百分比与重置时间（UI 约定 ④）；
  每轮的实际消耗放在「过程条」展开里（§5.3）。

### 4.4 匿名额度（决策 5、6）

新增一个**按权重扣**的原语（`ratecount.ts` 里加兄弟函数，不改 `consumeRateToken` 的语义）：

```ts
chargeRateCost(db, { scope: "anonquota", hmacKey, ip, tier, windowSec: 5h, limit: ANON_CHAT_QUOTA_TOKENS, cost, nowMs })
// SQL：UPDATE rate_counters SET count = count + ? WHERE bucket_key = ? AND count + ? <= ?
```

- **零新表、零新 secret**：沿用 `rate_counters`（`bucket_key` = HMAC 摘要，**不存明文 IP**；
  `window 推进即换 bucket`，天然自动重置）。
- **`count` 列语义按 scope 区分**：`search/llm/global/burst` = 次数，`block` = 时间戳（已有先例），
  `anonquota` = **加权 token**。需要在 `schema.sql` 注释与 `RateScope` 联合类型里写明。
- 默认 `ANON_CHAT_QUOTA_TOKENS = 6000`（env 可调）：约 3 次典型会话（每轮 1 检索 + 1 生成 ≈ 1.2k–1.9k），
  简单问题更多次。窗口 5h，与登录配额同一节奏（前端展示逻辑复用）。
- **匿名同时受分档限流**（`search` 与 `llm` 两个桶），额度与限流是**两道独立的闸门**，都要过。
- 匿名**不落会话**（决策 7）：上下文由客户端在请求体里回传，服务端**校验形状 + 限长**（复用
  `CHAT_MAX_ROUNDS` / `CHAT_MAX_HISTORY_MESSAGES` / `CHAT_MAX_MESSAGE_CHARS`），超限截断；
  来源登记表同样由客户端回传（服务端只接受自己签发过的形状，见 §4.8 的风险说明）。

### 4.5 防封号护栏（本节是生命线，对齐 `plan-ratelimit.md` §1）

把"不可预知的调用数"钉成常量上界，**每一个都要有 env 开关与默认值**：

| 上界 | 默认 | 作用 |
|---|---|---|
| `AGENT_TOOL_CALLS_PER_TURN` | **3** | 单轮最多 3 次检索（用户要求"至少三次"）。靠 §4.5.4 的四条合并/削减手段腾出预算（实测前不得再调高）|
| `AGENT_TOOL_CALLS_PER_SESSION` | **20** | 整会话（10 轮）总检索次数上限 |
| `AGENT_STEPS_MAX` | **4** | 模型调用步数上限（≤3 次工具 + 1 次最终回答）；与工具上限联动，不是独立旋钮 |
| `AGENT_TURN_TIMEOUT_MS` | **60_000** | 单轮墙钟上限（单次 LLM 调用仍受 `LLM_TIMEOUT_MS` 20s 约束）|
| `AGENT_MAX_SOURCES` | **24** | 会话来源登记表上限，防上下文与右栏爆炸 |
| 子请求预算 | **免费档 50/请求（硬顶）** | 见下方"子请求算术" |

#### ⚠️ 子请求算术（本功能最硬的约束，已查官方文档核实）

Cloudflare Workers 官方限额（developers.cloudflare.com/workers/platform/limits，2026-09-05 版）：

| 项 | Workers **Free** | Workers Paid |
|---|---|---|
| **Subrequests / invocation** | **50** | 10,000 |
| CPU time / HTTP 请求 | 10 ms | 5 min（默认 30s）|
| Simultaneous outgoing connections | 6 | 6 |

三条关键语义：

1. **"A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1."**
   → 不只是 `fetch()`：**每一次 KV 读写、每一次 D1 语句都算**（本 plan 按**最坏情况**把 `db.batch([a,b,c])` 当作 3 个子请求；
      官方文档未明确 batch 的计数方式，**实测时必须确认**，若 batch 只算 1 则上表整体乐观 6–10 个）。
2. **免费档的 50 无法调高**：`wrangler.jsonc` 的 `[limits] subrequests` 可以设，但官方原文
   "The **free account maximum is 50**"（付费档上限 10,000,000）。本项目 `wrangler.jsonc` 目前没有 `limits` 块。
3. **等待网络 I/O 不计入 CPU**（"Waiting on network requests … does not count toward CPU time"），
   且 **流式响应期间没有墙钟硬上限**（客户端连着就能继续发子请求）→ 所以瓶颈是**子请求数**，不是 10ms CPU 也不是墙钟。

**现状基线（静态清点，2026-09-13）**：一次 `/search/stream`（4 库 + rerank + LLM）大致消耗：

| 环节 | 子请求 | 说明 |
|---|---|---|
| KV 读（向量阶段缓存） | 1 | `cacheGetVectorStage` |
| embedding | 1 | `fetch` 硅基流动 |
| Qdrant 检索 | **1 × 库数（最多 4）** | `corpora.map(async …)` 每库一次 `fetch` |
| rerank | 1–2 | 候选 ≤64 → 每批 32 |
| KV 写（缓存） | 1 | `cachePutVectorStage`；线上实测 635–653ms，现走 `opts.waitUntil` 不阻塞响应（`search.ts:321–325`）——**但 `waitUntil` 里的子请求仍计入本 invocation 的 50**。agent 循环调 `runSearch` 时要把 `executionCtx.waitUntil` 透传进去 |
| 限流闸门（D1） | ~3–4 | `consumeRateToken` 一次 `batch` 三条语句 + 可能的 block 读 |
| 配额（D1） | ~3 | `chargeQuota` 一次 `batch` 对齐+判扣+回读 |
| key 用量记账（D1） | 1–2 | `key_usage` 写入 |
| LLM 调用 | 1 | `fetch` 硅基流动 |
| **合计** | **≈ 14–18** | 单次检索请求 |

**推论（这是本 plan 最重要的一条结论）**：一趟对话的开销 ≈ `工具调用数 × 15 + 模型调用数 × 2 + 固定 7`：

| 单轮配置 | 估计子请求 | 免费档 50 是否够 |
|---|---|---|
| 1 次检索 + 1 次生成 | ≈ 24 | ✅ 宽松 |
| 2 次检索 + 2 次生成 | ≈ 41 | ⚠️ 够，但没余量 |
| 3 次检索 + 3 次生成 | ≈ 58 | ❌ **超** |

→ 上面这张表是**"什么都不改"的算法**。用户要求"至少 3 次工具调用"，所以不能靠降上界解决，
**必须先把每次上游调用的固定成本压下来** —— 见 §4.5.4，压完之后 3 次不但够，而且有余量。

#### 4.5.4 把子请求压到 50 以内（"合并请求"方案，用户明确要求）

**先排除一个走不通的思路**：把 4 库并行检索合并成 1 个 HTTP 请求。

> 实测（官方 OpenAPI，Qdrant Cloud 1.19.1 实测联通，53 个端点逐个查过）：
> **Qdrant 没有任何跨 collection 的检索端点** —— 只有
> `/collections/{collection_name}/points/query/batch`（**同一 collection 内**批量查询）与
> `/collections/{collection_name}/points/batch`（批量写）。四个 wiki 分属四个 collection，
> **所以这 4 个请求合并不了**，除非改数据布局（见下方手段 ⑤）。

真正有效的"合并"在**记账层**，不在检索层：

| # | 手段 | 省下 | 代价 / 注意 |
|---|---|---|---|
| **①** | **D1 记账从"每次上游调用一次"合并为"每轮一次 `db.batch`"** | **最大一笔**：原来每次上游调用要 ~3 条语句（判-占 + 回读 + 记账），一轮 6 次上游调用就是 ~18 条；合并后整轮只剩入口 + 轮末两次 batch | ⚠️ **与 §4.5「闸门口径改为每次上游调用一次」冲突，需要改写**：改成"**入口按本轮上界（3 工具 + 4 步）一次性预占名额**，轮内不再打 D1，轮末按实际结算（只补不退）"。语义上**更保守**（宁可多算），且拿回了全部往返 |
| **②** | **chat 里关闭 KV 缓存写** | 每次检索 **1** | chat 不再为检索页暖缓存。**读保留**（1 个子请求，命中可省 embed+Qdrant 共 5，正期望）。实现：`RunSearchOpts` 加 `cacheWrite?: boolean`（现在写死在 `search.ts:323` 的 miss 分支里）|
| **③** | **key 用量记账并入轮末同一个 batch** | 每次上游调用 1–2 | 记账延迟到轮末（进程内累计）；轮末 batch 失败会丢这轮用量明细（可接受，`key_usage` 是观测不是账本）|
| **④** | **prompt 收紧 + 首步强制检索**（§4.9）| 减少步数与工具调用次数本身 | 模型自由度下降 —— **这正是用户要的** |
| **⑤** | *（二期独立议题）* **四库合并为单 collection**（加 `wiki` payload 字段 + filter）| 每次检索 **3**（4→1），**检索页一并受益** | 牵动 ingest / fallback / tree / wiki_registry，是独立迁移，不塞进本 plan |

**压完之后的复算**（保守口径：`db.batch` 按**语句数**计，即最坏情况）：

| 项 | 改前 | 改后 |
|---|---|---|
| 每轮固定（入口 batch：限流占位 + 配额预扣 + 轮末结算 + key 用量） | 拆成 ~18 条散在六处 | **1 次 batch ≈ 7 条语句**（轮末再 ~5）|
| 每次检索（工具调用） | 15 | **7**（KV 读 1 + embed 1 + Qdrant 4 + rerank 1）|
| 每次模型调用 | 8 | **1** |
| **一轮（3 次检索 + 3 次生成）** | **≈ 58 ❌** | **7 + 3×7 + 3×1 + 5 = 36 ✅** |
| 一轮（3 次检索 + 3 次生成，KV 写保留的坏情况） | — | **39 ✅** |
| 若再叠加手段 ⑤（单 collection） | — | **27 ✅**（余量足够再放宽到 4–5 次检索）|

→ **结论：3 次工具调用在免费档可行**，前提是①②③④必须一起做，不能只做一部分。
→ 仍然要**实测确认**：`db.batch` 到底算 1 个还是 N 个子请求（这是上表保守/乐观的分界，实测后可能再省 ~10 个）、
  以及 `waitUntil` 里的子请求是否全额计入。

**闸门口径改动（重要）**：`llm` 与 `search` 两个分档桶现在按"每个用户请求占 1 个名额"计。
chat 一轮可能触发 6 次上游调用，按"每请求 1 次"计会让护栏被绕过。
**但"每次上游调用各打一次 D1"会把固定成本放大 6 倍**（§4.5.4 ①）—— 所以采取**折中口径**：

- **入口按本轮上界一次性预占名额**（上界 = `AGENT_TOOL_CALLS_PER_TURN` + `AGENT_STEPS_MAX` = 7 个名额，
  在**同一个 `db.batch`** 里用现有的"判-占同句"批量占位）；
- **轮内不再打 D1**，只在内存里递减；
- **轮末按实际用量写一次 batch**（只补不退 → 语义比"按实际扣"更保守，宁可多算）。

这样既堵住了绕过（一轮至少按上界计），又把 D1 往返从 6 次压到 2 次。实现要点：`consumeRateToken()` 需要一个
"**批量占 N 个名额**"的变体（现有 SQL 是 `count = count + 1 WHERE count + 1 <= limit`，改成带步长的版本即可）。

**全局匿名熔断**：沿用软 300 / 硬 600；软熔断时匿名 chat **直接不入循环**（提示登录或稍后再试）。

#### 4.5.1 TPM 限额：agent 循环最容易撞的墙（实测发现）

实测拿到 429 原文：

```json
{"code":50602,"message":"Request was rejected due to rate limiting. Details: TPM limit reached.","data":null}
```

- 这是**按模型计的 TPM（tokens per minute）限额**，不是 QPS：当时 `GLM-4-9B-0414` 正常、`Qwen3.5-4B` 全部 429，
  **约 100s 后自行恢复，且没有 `Retry-After` 响应头**。
- 为什么这对 chat 特别致命：**一次提问 = 多次 LLM 调用 + 大块检索上下文**（system prompt 实测可达 2060 tokens，
  每步还要回灌检索片段）→ agent 循环是把 TPM 烧得最快的一种形态，比单次检索+总结高一个量级。
- 现有 `withKeyRetry` 只处理"换 key 重试一次"；**换 key 对 TPM 限额无效**（限额按模型/账号算，同一账号换 key 也超）。
  所以必须新增：

| 机制 | 做法 |
|---|---|
| **识别** | 把上游 429 的 `code: 50602` / `TPM limit reached` 单独归类为 `llm-tpm-limited`，**不与普通 429、也不与"账号被封"混为一谈**（现有 `classifyLlmError` 需要扩展一类）|
| **换模型** | 命中 TPM → **按决策 24 的链切**：`Qwen3.5-9B`（首选，待补测流式 FC）→ `GLM-4-9B-0414`（**只能非流式**，能力位会自动切到混合模式）|
| **退避** | 同模型内退避（实测恢复约 100s，无 `Retry-After` → 用固定/指数退避，初值 5s、上限 60s）|
| **收尾** | 循环中途撞 TPM：不再发起新的模型调用，**转入 §4.1 ④ 提前收尾**（已检索到的来源卡照常返回）|
| **护栏联动** | 该模型进入冷却窗口（进程内 + KV），冷却期内新请求直接用 failover 模型 |

**⚠️ 前提是首选 failover 模型的流式 FC 必须先补测**（`Qwen3.5-9B`，§2.6 未测项）——
一期开工前补一条探测。若它也支持规范流式，则 `Qwen3.5-4B → Qwen3.5-9B` 全程留在流式路径上，
**只有退到 GLM 时才降级为混合模式**（能力位 `supportsStreamingToolCalls=false` 自动生效）。

#### 4.5.2 两个必须同时改的 LLM 常量

| 项 | 现状 | chat 需要 |
|---|---|---|
| `enable_thinking` | `parseThinkingFlag()` 未设置时返回 **`false`** → 显式传 `false`（**安全，保持**）| 必须**永远显式传 `false`**；把 `omit` 列入禁用值（omit = 去掉字段 = 思考开启 = 33–45s 必超时）|
| `LLM_MAX_TOKENS` | `llm.ts:809` = `Math.min(parsePositiveInt(env, 800), 800)` → **env 只能调低，800 是硬顶** | chat 单条回答 300–800 字贴着上限，且循环里 `tool_calls` 的 `arguments` 同占额度 → **必须放开本地钳制**。实测可接受值：Qwen3.5-4B 支持到 131072；**GLM 只支持 16384（32768 报 400）且默认输出上限 4096** → **`AGENT_MAX_TOKENS` 默认取 2000**（两个模型都安全）|
| `LLM_TIMEOUT_MS` | 20s（思考关闭时足够：简单问句 2.45s、闭环 1.66–8.42s）| **保持 20s**；既然不做思考模式，不需要 90–180s 的长超时 |

#### 4.5.3 空回答防御（实测 1/9 次复现）

实测出现过一次：`enable_thinking:false` 下返回 `content: ""` + `finish_reason:"stop"`，整篇答案跑进了 `reasoning_content`。
代码核实：`extractDeltaContent()` 只读 `delta.content` / `message.content`，**完全忽略 `reasoning_content`**
→ 这种情况现在会**静默产出空回答**。防御：

1. 流结束后若累积正文为空：检查 `reasoning_content` 是否非空；
2. 非空 → 记为可诊断事件（打点 + warning），**重试一次**（同一模型）；
3. 再空 → 换 failover 模型一次；仍空 → 降级收尾，返回来源卡 + "AI 未能生成回答"（**不要显示空气泡**）。

### 4.6 会话与历史（决策 13）

`chat_sessions` 新增列（走 `schemaStatements.ts` 幂等迁移，沿用现有风格）：

| 新增列 | 类型 | 用途 |
|---|---|---|
| `title` | TEXT | 自动标题（首轮用户问题前 24 字，去换行）|
| `sources` | TEXT DEFAULT '[]' | 会话级来源登记表 JSON（§4.8）|
| `mode` | TEXT DEFAULT 'chat' | 预留：区分 `chat`（agent）与 `summary`（旧的先搜后总结）|

新路由（全部 `account_id` 归属校验，沿用 `/chat` 的 403 语义）：

```
GET    /api/v1/agent/sessions            列表（分页，按 updated_at 倒序，只出 id/title/updated_at/round_count）
POST   /api/v1/agent/chat                SSE 主入口（body: message, corpora, session_id?, options）
GET    /api/v1/agent/sessions/:id        回看（history + sources + corpora）
DELETE /api/v1/agent/sessions/:id        删除（级联删消息；软删或硬删见 §9 开放问题）
```

- 会话列表**只对登录用户**返回；匿名调用 → 401，前端文案为"登录后可保存对话记录"。
- 轮数上限沿用 10 轮（`CHAT_MAX_ROUNDS`）；超限提示开新会话（与 `/chat` 一致）。

### 4.7 SSE 协议（`/api/v1/agent/chat`）

延续现有 `event: <name>\ndata: <json>\n\n` 风格；事件集：

| 事件 | 时机 | 关键字段 |
|---|---|---|
| `session` | 会话建立后 | `session_id`, `max_rounds`, `anonymous` |
| `trace` | 每次工具调用前后 | `step`, `phase`（`search_start` / `search_done` / `generate_start` / `finalize`）, `tool`, `query`, `corpora` |
| `sources` | 工具返回后 | `sources: [{sid, doc_id, wiki, title, url, path, score, snippet, turn}]` |
| `delta` | 正文流式 | `text` |
| `citations` | 正文首包前 | `citations: [sid...]`（沿用 `extractCitationIndices` 的解析结果）|
| `usage` | 每步/整轮结束 | `quota`（百分比口径，复用 `toQuotaResponse`）, `tool_calls`, `turns`, `timings` |
| `done` | 正常结束 | `stop_reason`: `final` / `budget` / `timeout` / `tool_call_limit` / `degraded` |
| `error` | 失败 | `error`（机器可读码）+ `notice`（一句人话）|

**失败要分开说**（tmp.md 明确要求）：`search-empty`（检索为空）/ `search-timeout`（上游超时）/
`llm-unavailable`（池全灭）/ `refused`（模型拒答）/ `quota-exceeded` 各自独立的码与文案，
**不要都显示成"出错了"**。

### 4.8 引用编号：会话级来源登记（决策 12）

- 登记表 `[{sid:"s1", doc_id, wiki, title, url, path, snippet, first_turn}]`，`sid` 会话内单调递增。
- 工具返回的片段**以 sid 标注**喂给模型；prompt 里写明"引用格式 `[来源1]`"，其中数字 = **sid 的数字部分**，
  这样直接复用现有 `extractCitationIndices`。
- 前端把 `[来源n]` 渲染成角标 `n`，点击滚到来源卡并高亮。
- **匿名路径的风险与缓解**：客户端回传历史与来源表，用户可能伪造"过去检索到的来源"。
  缓解：① 服务端只接受自己签发过的字段形状与长度上限；② **本轮引用一律以服务端本轮真实工具结果为准**
  （前端渲染点击回跳时只用服务端本轮/本会话签发的 url）；
  ③ 伪造的后果仅限于"自己骗自己"，不构成越权（无密钥、无他人数据）。
- 该表同时是二期「钉住来源」与「仅用已引用文献答」的数据基础，所以**一期就按稳定 id 做**，不先做"每轮重置"。

### 4.9 prompt（`agent/prompt.ts`）

在现有 `LLM_SYSTEM_PROMPT`（五条硬约束）基础上追加 chat 专属条款。
**用户明确要求"预设 prompt 里也尽量限制模型发挥"** —— 因为每一步都直接换算成子请求、TPM 与用户等待时间：

**A. 检索行为（核心：把"自主"关进笼子）**

1. **任何问题都必须先调用 `search_wiki`**，包括常识问题、闲聊、「1+1 等于几」（决策 10）。
   实现上是**双保险**：首步直接 `tool_choice` 强制调用（§4.1），prompt 里再写一遍。
2. **最多检索 3 次，但优先 1 次就够**：明确写"若已检索到的片段足以回答，**立即作答，不要为了更全面而追加检索**"。
3. **不要重复检索同一个 query**；第二次起**必须换关键词**（换成更具体的术语/同义词），
   且**必须说明这次在查什么**（前端过程条要显示）。
4. **不要在回答末尾偷偷补检**：检索只发生在开头，一旦开始写正文就写完。
5. 检索返回"未找到"时：**最多改写一次**；再没有就直说没有依据，**不要无限换词试探**。

**B. 输出行为（减少无谓 token 与"发挥"）**

6. **直接回答，禁止寒暄与元话术**：不写「好的，我来帮你查一下」「希望以上信息对你有帮助」
   「作为 AI 我无法…」这类；不复述用户问题；不解释你用了什么工具、什么规则。
7. **不输出思考过程**、不自我评价（「这个回答很全面」）、不列"可选进一步提问"清单。
8. **长度纪律**：默认 **≤400 字**；只有用户明确要求"详细/展开/多说点"才写长。
   分段/小标题/列表都可以，但不写与问题无关的铺垫与总结套话。
9. **引用格式固定**：结论句尾标 `[来源n]`，**不引用的句子不要乱标**；不编造来源编号。
10. **不重复整段原文**：引用要"转述 + 标注"，不要大段照抄片段（那既占 token 又没信息量）。

**C. 内容边界**

11. 只依据工具返回的片段作答；**片段没有依据必须明说"没有找到依据"**，不得用模型自身知识补充。
12. 医疗相关必须提示"以原文与医生意见为准"（沿用 `/about` 免责口径，且**只说一次**，不要每段都提）。

**D. 上下文**

13. 来源清单以系统消息形式给出（会话已有来源的 sid + 标题），让模型知道可以引用旧来源；
    但**优先用本轮检索结果**，不要拿旧来源凑数。

### 4.10 模型适配层（为将来换 DeepSeek 留路，决策 22）

用户明确说"后面可能换 DeepSeek，因为 9B 模型没竞争力"。所以**现在就把供应商差异关在一个薄层里**，
将来换模型是改配置而不是重写循环。`llm.ts` 现在是"硬编码 OpenAI 兼容 + Qwen 专有字段"的形态：

| 差异点 | 现状（硅基流动） | DeepSeek 需要确认的 | 适配层要做的事 |
|---|---|---|---|
| 端点 / 鉴权 | `api.siliconflow.cn/v1/chat/completions` + Bearer | 官方文档待查（子代理调研中）| env 已经能覆盖 `LLM_ENDPOINT`；补 base_url + model 的命名空间 |
| **思考控制** | `enable_thinking`：**不传 = 开启**（陷阱），`true` 档 14–131s，`thinking_budget`/`reasoning_effort` 被静默忽略 | DeepSeek 可能是独立 model id（如 reasoner）或参数；**是否接受 `enable_thinking` 会 400 还是忽略？** | 适配器把"我们想要的语义"（本轮关思考 / 开思考）翻译成**该供应商的写法**；**绝不能把 `enable_thinking` 无条件透传**（不接受的供应商会 400）|
| **tool_calls 形状** | 流式：id/name 仅首片、arguments 逐片拼；强制模式下 `finish_reason:"stop"` | DeepSeek 的分片与 finish_reason 约定 | 适配器只暴露**归一化结果**（`{id, name, args, finishReason}`），循环不碰原始形状 |
| **思考内容字段** | `reasoning_content`（且会出现"正文跑进 reasoning_content、content 为空"的异常）| 字段名可能不同 | 归一化成 `{content, reasoning}`，空回答防御（§4.5.3）写在适配层之上 |
| **429 / 限额语义** | `code:50602` = 按模型 TPM | 错误码体系不同 | 归一化成内部错误类（`rate-limited` / `tpm-limited` / `quota` / `auth`），循环与退避逻辑不认供应商码 |
| **价格** | 长期免费（但未证实候选免费）| 按 token 计费 | 配额口径（§4.3）要能容纳"真花钱"的场景 → 现在就把成本常量做成 env，别写死 |

**边界**：适配器只管"怎么跟一个 OpenAI 兼容端点说话"，**不管** agent 循环、工具、配额、限流、密钥池 ——
那些是供应商无关的，也是本仓库 9k 行复用价值的所在。

#### 4.10.1 DeepSeek 的已知事实与三条 400 陷阱（来自官方文档，§2.7）

| 项 | 事实 | 对适配层的要求 |
|---|---|---|
| 模型 id | `deepseek-flash` / `deepseek-v4-pro` | 模型表要能声明"上下文 / 最大输出 / 是否支持思考分级"|
| 思考控制 | `thinking:{"type":"enabled"\|"disabled"}` + `reasoning_effort: none\|low\|high\|max`，**真实生效** | 抽象成**我们自己的语义**（关/低/中/高），由适配器翻译；**不要**把 `enable_thinking` 透传过去 |
| 流式 tool_calls | **标准 OpenAI 形状**（首片带 id/type/function）| 与 Qwen 同路径，不需要额外分支 |
| **陷阱 1** | **思考模式下 `tool_choice:"required"` 或指定函数会 400** | 我们"首步强制检索"（决策 10）在 DS 上要么改成 `auto`+prompt，要么**先关思考再强制** → 适配层提供 `canForceToolWithThinking` 能力位 |
| **陷阱 2** | **带 `tools` 时必须把历史 `reasoning_content` 全量回传**，否则 400 | 会话历史存储结构要能装 `reasoning_content`（现在 `chat_sessions.history` 只存 role/content）|
| **陷阱 3** | **Chat Completions 不支持会话中途插入 tool call 消息** | 要确认我们"全量历史回放 + assistant(tool_calls) 位置"合法；不合法就得改用 Anthropic / Responses API 形状 |
| 价格 | `deepseek-flash` 输出 **$0.6–1.2 / 1M tokens**（off-peak/peak）| **不再是免费** → 配额成本常量必须可配（现在 `QUOTA_COST` 是写死的常量），否则切过去会"按免费口径收费"|
| 上下文 / 输出 | **1M / 384K**；未设 `max_tokens` 时默认非思考 8K / 思考 64K / effort=max 128K | 比硅基流动宽得多，GLM 的 32k 约束消失 |

**切换 DeepSeek 前必须先验证的四件事**（不预设结论；前三条仍待**实测**，因为文档不保证行为）：

1. **tool calling 实测**（文档说形状标准，但要拿 key 验证）：流式分片、`finish_reason`、多轮闭环；
2. **`enable_thinking` 是否 400** —— 文档全文没有这个字段，**传了会怎样无法从文档确定**（这直接决定适配层要不要"按供应商删字段"）；
3. **思考模式的真实边界**：与 `tools` 组合时的 400 条件（陷阱 1/2）、`reasoning_content` 回传要求；
4. **题材合规（前置问题，不是运维问题）**：官方条款**没有**点名禁止跨性别/性少数医疗信息
   （最接近的是 §3.4「输出不得歧视 sexuality」、§3.6(2)「不得危害身体健康」），但
   **Open Platform ToS §7.2 允许"单方认定 + 无事先通知"封号** → 必须**先做拒答率抽样**
   （拿本项目典型问题跑一批，统计拒答/说教/回避比例）再决定是否切换，而不是切完再看。

---

## 5. 前端设计（并入 tmp.md 全部建议）

### 5.1 入口与模式切换（决策 2、3、4）

- **顶栏分段切换**：`检索 | 对话`，两个 `NuxtLink`，当前路由决定选中态（单一数据源）。
- 位置：`app.vue` 顶栏 logo 右侧（现有"常驻只留设置+主题"的约定不变，切换器是**导航**不是操作）。
- `<640px`：切换器保留（它是主要导航），「设置」降级为图标（沿用 TODO 里已有的窄屏方案）。
- `chat.chengxi.moe` 整站 302 → `search.chengxi.moe/chat`（**定案 (b)，见 §3.4**）：
  由 Pages 的 `_redirects` 或页面级 302 完成，**前端代码零改动**，不需要客户端 host 判断插件。
  两种模式的默认落地因此统一走路由：`/` 检索、`/chat` 对话。
- **共享**：知识库多选、设置、账号菜单、免责弹窗、主题 —— 与检索页同一套组件与同一份偏好（`usePrefs`）。

### 5.2 布局

- **一期（MVP）**：单栏对话 + 底部固定输入 + 回答下方来源卡 + 可展开的过程条。
  （tmp.md 的"最小可行结构"：先把「能追问、能点回原文、能看出查过库」做稳。）
- **二期**：左栏（可收）会话列表 / 新对话 / 知识库开关 / 常用场景；
  右栏（按需展开）本轮文献卡 + 语义分数 + 原文片段 + 工具调用时间线。
- **小屏降级**：左栏 → 抽屉；右栏 → 消息下方的「来源」折叠区。
- **明确不做**：把检索页那种"中间结果列表 + 右侧生成中"照搬进 chat —— 那是搜索，不是聊天。

### 5.3 每轮助手消息拆成三层（不合成一坨）

1. **过程条（默认收起）**：`正在检索 MtF Wiki · 心理评估 → 命中 8 条，采用 3 条 → 生成回答`；
   多次检索就多段。普通用户只看"用了 3 条来源"，展开才看工具轨迹时间线。
2. **回答正文**：接近文档排版（字号/行高/引用块），短段落、小标题、列表；
   关键结论后用角标 `[1][2]`，点击滚到来源卡或弹出原文片段。
   —— **不要气泡+圆角那种社交软件感**：助手消息用文档排版，用户消息用普通气泡，主次清楚。
3. **来源条**：回答底下横排 2–4 张小卡（知识库名、标题、路径、相似度）。**这是 chat 的信任核心**，
   优先级高于任何视觉打磨。

### 5.4 引用与来源

- **默认引用强制可见**：没有来源的回答**降权显示**并标「未检索到依据」（决策 11）。
- 来源卡一键**「在 Prism 中打开」**（跳检索页并带上该条命中）；反向：检索页结果卡加**「就这篇来问」**
  （跳 `/chat` 并把该 hit 作为初始来源）。这是两模式"同一产品"的关键咬合点。
- 来源卡数据来自 SSE 的 `sources` 事件，**不前端猜**。

### 5.5 输入区（固定底部）

- 三个开关（默认值见括号）：
  - **带上本轮来源继续问**（默认**开**）
  - **仅用已引用文献答**（默认关）→ 传 `options.only_cited`，服务端限制工具只返回已登记来源
  - **重新检索后再答**（默认关）→ 传 `options.re_search`，强制至少一次工具调用
  - 二期：点选某几条来源作为下一轮约束、钉住（pin）
- **思考强度：SiliconFlow 上不做**（决策 14）。实测已排除：`thinking_budget` / `reasoning_effort` 都被上游静默忽略
  （对照实验：瞎编一个参数名同样返回 HTTP 200），唯一生效的是二值 `enable_thinking`，
  而它的 `true` 档实测 14–131s。**输入区因此只有三个开关，不出现任何"思考"相关的控件** ——
  放一个点了只有 20s 超时或分钟级等待的按钮，比没有更糟。
  **但这条不是永久的**：文档调研确认 **DeepSeek 的 `reasoning_effort`（none/low/high/max）是真实分级**
  （§2.7①），所以**将来切到 DS 时这个控件就能做了** → 服务端现在就按"关/低/中/高"的自家语义留好
  `AGENT_THINKING` 抽象（**不上 UI**），届时只加前端控件、不动后端。
- **免责固定在输入框上方或首条系统消息里**：`AI 不能替代医生，以原文为准。`
  （chat 比检索更容易被当成"问诊"，这句必须有；沿用 `/about` 的口径）。
- 轮数/额度提示：接近上限时在输入框上方一行短提示，**不弹窗**。

### 5.6 空状态（不做空白对话框）

- 首屏用现有首页的示例问法做 chips：
  - `HRT 激素替代常用方案有哪些？`
  - `跨性别证件姓名与性别变更指引`
  - `性别重置手术心理评估流程`
- 一句短提示说明"这是一个会先查四部 wiki、再回答的助手，回答都带来源"。
- **不做仿 ChatGPT 的纯净空白**：医疗/社群指南场景需要过程可见。

### 5.7 会话列表（决策 13，一期做）

- 左栏列出会话（标题 = 首轮问题前 24 字）+ 「新对话」。
- 点击回看历史（history + 来源登记 + 当时的知识库选择）。
- 可删除（需确认，复用 `ConfirmDialog.vue`）；可重命名放二期。
- 匿名：不显示列表，显示一行"登录后可保存对话记录"。

### 5.8 视觉与既有约定

- **继承 Prism**：搜索框气质、蓝主色、卡片、知识库 pill、语义重排百分比。
- **不学 Wiki 文档站**（chat 不是侧栏长文），但回答区可略偏 Wiki 的阅读排版（用户要在气泡里读 300–800 字）。
- 遵守 `MEMORY` 里的 16 条 UI 约定（尤其 ① 单一数据源、⑤ 确定性行结构、④ 短提示、⑮ 弱徽章）。
- `tmp.md` 的"不建议做"清单一律不做：不把结果列表塞进聊天记录、不一上来全屏长文把来源藏底部、
  不左右各做一个完整 Wiki 预览。

---

## 6. 降级与失败（三条路径都必须真跑一遍）

| 情形 | 行为 |
|---|---|
| 模型**不支持** tool calling | chat 退化为「先搜后总结 + 多轮追问」= 把现有 `AI 伴读` 搬到 `/chat` 页；过程条文案改为"已检索后作答"。（现状**不会发生**：现用模型与 failover 都已实测支持 FC，保留此路径只为换模型时的兜底）|
| **TPM 限额 429（`code 50602`）** | 切 failover 模型（GLM-4-9B-0414）→ 仍不行则退避/提前收尾；`stop_reason=degraded`（§4.5.1）|
| **模型返回空正文**（`content:""` 但 `reasoning_content` 非空）| 重试一次 → 换 failover 一次 → 降级收尾；**绝不显示空气泡**（§4.5.3）|
| 池全灭 / 上游超时 | 已获得的来源卡照常返回 + 一句"AI 暂不可用，以下是直接检索到的原文"；`stop_reason=degraded` |
| 检索为空 | 明确回 `search-empty`，回答位标「未检索到依据」，**不编造** |
| 轮数/额度/步数用尽 | 提前收尾（§4.1 ④），`stop_reason` 分别 `tool_call_limit` / `budget` / `timeout` |
| D1 不可用 | 沿用现有 fail-open（打 warning）；匿名额度失效时按"放行但限流兜底"处理 |

---

## 7. 分期实施

> **M1 之前的必做前置**：
> 1. ✅ **GLM 流式 FC 已测**（结论：**坏的**，6/6）→ 默认模型据此改回 Qwen3.5-4B（决策 20，**待用户确认**），
>    GLM 只作非流式兜底。
> 2. **确认 `db.batch` 的子请求计数方式**（§4.5.4）—— 这是"3 次工具调用够不够"的分界，
>    决定要不要把 ⑤（单 collection）提前。
> 3. **补测 `Qwen/Qwen3.5-9B`（或 `35B-A3B`）的流式 FC** —— 它现在是**首选 failover 候选**
>    （GLM 因流式 FC 坏 + 32k 上下文，只适合做最后兜底）。

### M1 —— 能对话、能对照原文（可用性成立）
后端：`agent/`（loop / tools / prompt / sources / budget / providers）+ `/api/v1/agent/chat` + SSE 事件
+ **§4.5.4 的合并记账（① 每轮一次 batch、② 关缓存写、③ key 记账合批）** + 匿名额度桶 + 子请求计数打点。
前端：`/chat` 页 + 顶栏切换 + 对话流三层结构 + 来源卡 + 过程条 + 输入区三开关 + 空状态 chips + 免责。
验收：见 §8 的 1–8 条（**第 5 条子请求实测是 M1 的硬门槛**）。

### M2 —— 会话与历史（决策 13）
后端：`chat_sessions` 迁移（title/sources/mode）+ 会话 CRUD 路由 + `chat.chengxi.moe` 的 Pages 302 规则。
前端：左栏会话列表 + 新对话 + 回看 + 删除。

### M3 —— 深挖（tmp.md 的二期内容）
右栏来源面板、钉住来源、`read_document` 工具、与检索页双向跳、常用场景入口。

### M4（未定）—— 换 DeepSeek
不属于本 plan，但**边界现在就要留**（决策 22 / §4.10）。切换前的三问见 §9 风险 14：
真实 tool-calling 行为、思考控制机制（要用对照实验验证）、**题材合规**。

> **不做的理由留档**：不拆仓库、不做独立后端、不做多 agent/多工具编排（一期一个工具就够，
> 每多一个工具就多一层不可预知的成本与故障面）。
> **思考强度选择不做**（决策 14 / §2.5）：实测无可用的分级旋钮，唯一一档还会把延迟推到分钟级。
> **不把四库合并成单 collection**（§4.5.4 ⑤）：收益真实（每次检索省 3 个子请求，检索页也受益），
> 但牵动 ingest / fallback / tree / wiki_registry，属于独立迁移 —— 等子请求实测数字出来再决定是否单独立项。

---

## 8. 验收标准

1. **功能**：`/chat` 能多轮对话，答案带可点击的 `[来源n]`，点击回到对应来源卡与原文链接。
2. **自主检索可见**：过程条能显示"查了什么库、命中几条、采用几条"；用户问 `1+1` 也**必须**发生一次检索（决策 10）。
3. **无依据不编**：构造一个四部 wiki 都没有答案的问题 → 回答明确说"没有找到依据"，且不给出 wiki 之外的结论。
4. **护栏真触发**（沿用本项目"必须真跑"的验收传统）：
   - 单轮第 4 次工具调用被拒 → 提前收尾，`stop_reason=tool_call_limit`（上界是 3）；
   - **prompt 收敛生效**：问一个明显一句话能答的 wiki 问题 → 工具调用数应为 **1**（不是 3），步数为 2；
   - 匿名 6000 token 用尽 → 明确拒绝并提示登录，`scope=anonquota` 桶计数与实测一致；
   - 分档限流按**每次上游调用**生效（一轮 3 次上游调用应占 3 个名额，实测验证）；
   - 池全灭演练：检索照常、AI 降级、`stop_reason=degraded`（沿用 W6 演练方式）；
   - **TPM 429 演练**：人为压测打满某模型 TPM → 验证自动切 `GLM-4-9B-0414` 且**不表现为"出错了"**（§4.5.1）。
5. **子请求/CPU 实测**：
   - 逐项验证 §4.5.4 的四条手段：`db.batch` 算 1 个还是 N 个子请求（**这是保守/乐观的分界**）、
     `waitUntil` 里的子请求是否全额计入、关闭缓存写后 chat 的检索是否仍走通；
   - 满配（**3 次工具调用 + 3 次生成**）实跑，记录子请求数与 CPU ms，**必须 ≤50**；
   - 实测数字写进代码注释与 `history.md` 坑 51；若超了，按 §4.5.4 的优先级追加手段（下一个是 ⑤ 单 collection）。
6. **成本口径**：一趟对话的 `used_tokens` 增量 = Σ(每次工具调用 360 + 每次 LLM 真实 token)，实测对账。
7. **协议正确性（实测已知的坑）**：单测必须覆盖
   ① 强制 `tool_choice` 时 `finish_reason:"stop"`（Qwen）**与** `"tool_calls"`（GLM）→ **两种都要走工具分支**；
   ② 流式 `tool_calls` 分片两种形态：**首片带 id/name（Qwen）** 与 **首片不带、且 arguments 是坏的（GLM）** →
   后者必须被判为"无效调用"并回落到非流式，**不能静默产出错参数**；
   ③ `choices: []` 的 usage 末片（Qwen）与**每 chunk 带累积 usage**（GLM）都不崩；
   ④ 空 `content` + 非空 `reasoning_content` → 触发重试而不是产出空回答；
   ⑤ **空结果的服务端改写重试**触发且只触发一次（§4.1.2）；
   ⑥ **引用校验**：正文里出现来源登记表之外的 `[来源n]` → 被移除并记 warning（§4.1.3）。
7. **匿名/登录差异**：匿名能对话但不可回看（文案正确）；登录后可回看、可删除；token 仍只在 localStorage。
   **并按 §3.4 验证登录态**：在 `chat` 域发起的登录能真正在 `chat` 域生效（或按 (b) 方案验证 302 后一路畅通，
   且不存在"在 A 域登录、B 域未登录"的困惑态）。
8. **测试**：`npm test`（现有 649 用例）+ agent 循环新增单测（步数/预算/超时/降级/引用解析）+ `tsc` 0 错；
   前端 `typecheck` + `generate` 通过。
9. **文档**：`README.md` 功能表与 API 表、`TODO.md`（关掉 §4）、`history.md` 坑 51、`/about` 隐私说明
   （新增"对话内容仅在登录时保存"）。

---

## 9. 风险与开放问题

| # | 问题 | 现状/建议 |
|---|---|---|
| 1 | **子请求上限 50（免费档，无法调高）**（§4.5.4） | 已核实官方文档：fetch + KV + D1 全都计入，`[limits] subrequests` 免费档上限就是 50。**用户要求支持 3 次工具调用** → 靠 §4.5.4 的四条手段（D1 记账合并为每轮一次 / 关缓存写 / key 记账合批 / prompt 收敛）把一轮从 ≈58 压到 **≈36**。**所有数字都待实测**（`db.batch` 的计数方式是最大不确定项）|
| 2 | 小模型的 tool-calling 稳定性 | 9B/4B 级模型可能：反复调同一 query、忘记标注引用、把工具结果当用户话说。缓解：**首步强制检索**（不再依赖模型自觉）+ prompt 显式禁止重复检索与"为更全面追加检索"（§4.9 A）+ 步数上界 + 引用缺失时前端降权。**好消息**：实测模型会自主改写 query 重试，agentic 行为是真的 |
| 3 | ~~思考模式与 20s 超时~~ | **已关闭**（实测）：思考强度无可调分级，`enable_thinking:true` 实测 14–131s → **不做该功能**，chat 恒为 `false`（决策 14 / §2.5）|
| 4 | 匿名额度的公平性 | 按 HMAC(IP) 计：NAT/校园网共享出口会互相消耗；阈值按 6000 起步，内测后按 `/admin/ratelimit` 分布校准（同 `TODO.md` §3 的技术债做法）|
| 5 | 删除会话的语义 | 硬删（清 history/sources）vs 软删（保留 id）。倾向**硬删**：这是隐私敏感内容，用户点删除就应真删 |
| 6 | `mode` 列与旧 `/chat` 路由 | 旧 `/chat`（非流式）保留给检索页 AI 伴读追问；`/agent/*` 是 chat 页专用。两者共用 `chat_sessions` 表但 `mode` 区分 |
| 7 | 上限数值的初值 | 3 工具 / 20 会话检索 / 4 步 / 60s 都是**保守起点**，内测后按实测的调用数与延迟分布调整；数据来源是 `/admin/usage/summary` 与新增的 agent 打点 |
| 8 | 对外命名 | 需要与用户最终确认对外文案：模式名「对话」、能力名是否沿用「AI 伴读」、`chat.chengxi.moe` 的标题与描述 |
| 9 | ~~域名策略~~ **已定案** | **(b)**：`chat.chengxi.moe` 整站 302 → `search.chengxi.moe/chat`。Worker 侧 `ALLOWED_ORIGINS` 与 `OAUTH_REDIRECT_URI` **都不用改**（§3.4）|
| 10 | 是否升 Workers Paid | 压完子请求后**免费档够 3 次工具调用** → **暂不需要升**。若将来想放开到 5 次以上、或叠加 `read_document` 等新工具，再评估（$5/月）|
| 11 | **TPM 限额是新的主风险** | 实测上游按模型计 TPM（`code 50602`），而 agent 循环是烧 TPM 最快的形态。现有 `withKeyRetry` 换 key **对 TPM 无效**（同账号换 key 一样超）→ 必须新增"识别 + **换模型** + 退避 + 冷却"（§4.5.1）。**切换顺序按决策 24 的 failover 链**：Qwen3.5-4B → Qwen3.5-9B → GLM（非流式）。**这条比子请求上限更可能在上线后咬人** |
| 12 | ~~GLM 流式 FC 未测~~ **已测，是坏的** | **6/6 复现损坏**：函数名被塞进 `arguments`、真参数缺失、`id` 恒 null → **GLM 不能做默认模型**（§2.3 坑 7）。另：GLM 上下文仅 **32768**、空结果**不重试**、引用遵守率不稳。**但非流式 FC 好、快（0.51s）、不偷懒（5/5 主动调工具）→ 适合做非流式兜底** |
| 13 | "免费"未获证实 | 硅基流动 API 不暴露价格字段（`/v1/models` 无价格、定价接口 307 跳登录）→ §2.2 里除现用模型外的候选只按"非 Pro 前缀"推断。**换模型前要人工核对一次定价页** |
| 14 | **将来换 DeepSeek：合规是前置问题** | 用户已明确计划换 DeepSeek（"9B 没竞争力，RAG + prompt 可能不如通用 AI"）。**文档调研已完成**（§2.7）：OpenAI 兼容 ✓、tool calling ✓（流式形状标准）、**思考分级真实可用 ✓**（`reasoning_effort: none/low/high/max`）、上下文 1M ✓；代价是**不再免费**（输出 $0.6–1.2/1M tokens）。三个待**实测**：流式行为、`enable_thinking` 是否 400、思考 + `tools` 的 400 条件。**合规**：条款未点名禁止该题材，但 **§7.2「单方认定 + 无通知即可封号」**与 `plan.md` §8.5 的"灰产 key"属同类失效模式 → **切换前必须做拒答率抽样**（§4.10.1）|
| 15 | 适配层不能拖到换模型时再补 | 若现在把 `enable_thinking` 无条件透传、把 Qwen 的 tool_calls 形状写进循环，换 DeepSeek 时就是一次重写（**DS 用的是 `thinking`/`reasoning_effort`，官方文档里根本没有 `enable_thinking`**）。**决策 22 要求现在就做 `agent/providers/` 薄适配层**（§4.10）|
| 16 | ✅ **默认模型已确认** | 已向用户出示实测证据（GLM 流式 `tool_calls` 6/6 损坏），**用户确认改回 `Qwen/Qwen3.5-4B` 做默认、GLM 降为非流式兜底**；流式策略也确认为**按 provider 能力位分流**（决策 20 / 23 / 24）|
