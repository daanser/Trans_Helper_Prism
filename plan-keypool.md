# plan-keypool.md —— 密钥池重构（合并池 + `POOL_KEYS_N` 分变量）

> 状态：**待确认（4 个取舍）**，确认后即实施（预计 3–4 小时含测试）
> 起因（用户 2026-09-12）："能不能把 embed 和 llm 融合成一个 POOL_KEYS，然后第一个改叫 POOL_KEYS_0，后面数字递增，要不然变量太多了"

---

## 1. 现状与痛点

| 现状 | 说明 |
|---|---|
| 三个池 | `PoolName = "embed" \| "llm" \| "rerank"`；`RERANK_POOL_KEYS` 缺省时**回落到 LLM 池** |
| 配置 | `EMBED_POOL_KEYS` / `LLM_POOL_KEYS` / `RERANK_POOL_KEYS` —— **本机与线上都是同一个 key 各填一遍** |
| **ref 按索引生成** | `parsePoolKeys(raw, pool)` → **`${pool}-key-${i}`**；删掉/调换中间一把 key → **后续 ref 全部移位**，而禁用集与 `provider_keys` 表都是按 ref 记的（**错位=误伤或误放**）|
| 加一把 key 的成本 | CF Secret **写入后不可读回** → 必须把整串逗号列表**重打一遍**，第 5 把时极易出错 |

**为什么合并是对的**：这些 key 是**同一个硅基流动账号的通用 key**，bge-m3 / bge-reranker / Qwen 全都能用 →
按"能力"拆三个池只是记账负担，没有任何实际隔离价值。（若将来某把 key 只对部分模型可用，再引入**每 key 能力覆盖**即可。）

---

## 2. 设计

### 2.1 变量与命名（用户指定）
```
POOL_KEYS_0 = <key>      # 数字递增，不要求连续（删掉 _1 不影响其它）
POOL_KEYS_1 = <key>
POOL_KEYS_2 = <key>
```
- 代码**按前缀扫描 `env`**，收集所有匹配 `^POOL_KEYS_(\d+)$` 的变量，**按数字升序**入池；
- 每个变量**推荐只放一把 key**（放多把也支持，用逗号分隔；但 ref 稳定性建议一变量一把）；
- **ref = `pool-key-<n>`**（直接用你填的数字）→ **天然稳定**：新增/删除别的变量都不影响既有 ref；
- 完整 key 值**永不回显**：`/admin/keys`、日志、错误信息都只出 ref。

### 2.2 单一逻辑池，但保留按能力的用量统计
- 对外只暴露**一个池 `keys`**（`/admin/keys` 的 `pools` 只有一项）；
- 但 `pickKey("embed" | "llm" | "rerank")` **三个入口仍然存在**，内部**指向同一份 key 列表** →
  **调用点零改动**，且 `key_usage.pool` 继续按能力记录（**embedding/rerank/chat 的用量统计不受影响**）；
- 这样"合并池"与"按能力看用量"两件事互不干扰。

### 2.3 禁用语义
合并后**一把 key 就是一个整体**：`POST /admin/keys {key_ref:"pool-key-2", enabled:false}` → **全能力禁用**（embed/rerank/llm 一起）。
（现状是按池分开禁 —— 合并后没有意义，且分开禁会出现"embed 禁了但 llm 还在用同一把"的怪状态。）

### 2.4 过渡期兼容（**关键：不能有中断窗口**）
我**无法编辑 CF Secret**，所以迁移必须由你在控制台操作。为了让"你操作到一半"也不中断：
1. 代码**同时读新变量与旧变量**：`POOL_KEYS_*`（新）+ `EMBED_/LLM_/RERANK_POOL_KEYS`（旧），合并成一个池；
2. **按 key 值去重**：同一个 key 同时出现在新旧变量里时，**保留新变量的那份**（ref 用 `pool-key-<n>`），旧的那份丢弃；
3. 因此你可以：**先加新变量 → 验证 → 再删旧变量**，全程服务不中断；
4. 旧变量的 ref（`embed-key-0` 等）在过渡期内仍然有效（禁用集/`provider_keys` 表里的历史记录不会失效）；
5. 迁移完成后（旧变量删掉），ref 只剩 `pool-key-<n>`。**当前禁用集是空的**，所以没有历史包袱。

### 2.5 顺带修：并列时只打第一把 key（负载均衡）
`pickKey()` 现状：`inFlightCount ↑` 并列时 `cooldownUntil ↑`，两者都并列 → **sort 稳定 → 永远选第一把**。
顺序请求全部落在 key#1、第二把闲置（只在并发或失败时用到）。
**改**：并列时按 **LRU（最久未用优先）**，即 `a.lastUsedAt - b.lastUsedAt` →
顺序请求也能在多个 key/账号间**轮流**；**同时把用量摊到多个账号上（每个账号用量减半）**，正对"防封号"这个真实目标。

### 2.6 管理端与探活
- `/admin/keys`：`pools` 变成一项 `{pool:"keys", configured:N, refs:[...]}`；`POST` 的 `pool` 字段接受 `"keys"`（旧值 `embed/llm/rerank` 仍接受并映射到同一池，避免旧脚本失效）；
- watchdog ④ 的判据**无需改动**（它遍历 `pools[]` 判 `configured < 2`，是通用的）→ 每池 2 把后自动转绿；
- `/admin` 前端 key 池区块同样通用，只需文案里池名显示为 `keys`。

---

## 3. 影响面（代码）

| 文件 | 改动 |
|---|---|
| `src/keypool.ts` | 扫描 `env` 收集 `POOL_KEYS_*`；新 `parseMergedKeys()`；ref 改为 `pool-key-<n>`；三入口共享同一列表；LRU 次序 |
| `src/keyadmin.ts` | 禁用集的池枚举（合并后单池；`setDenied` 作用于全部能力入口）|
| `src/types.ts` | 新增 `POOL_KEYS_*`（动态键，不逐个声明）；旧三个标"推荐迁移到 POOL_KEYS_N" |
| `src/index.ts` | `KeyPool.fromEnv` 的池构造与 `/admin/keys` 的 `pools` 输出 |
| `.github/workflows/*` | 摄取用 `EMBED_POOL_KEYS` → 改为 `POOL_KEYS_*`（GitHub Secret 我可以直接改）|
| 文档 | `plan-ratelimit.md`（§3.5 key 池）、`history.md`、`plan-m4.md` |

**不做**：不把密钥存进 D1（`plan-keypool` 方案 B 留待 key 数量长到 5+ 把再议）。

---

## 4. 验收

1. **兼容**：只配旧变量 → 行为与今天一致（池容量相同、ref 相同）；只配新变量 → 工作；**两者都配** → 去重后不重复计 key，且**优先用新变量的 ref**。
2. **ref 稳定**：删掉 `POOL_KEYS_1` 后，`pool-key-0` / `pool-key-2` 的 ref **不变**（对照旧实现会移位）。
3. **禁用生效范围**：禁用 `pool-key-1` 后，**embed/rerank/llm 三条链路都不再用它**（可用日志或单测断言）。
4. **负载均衡**：连续 10 次顺序取 key → 两把 key 各约 5 次（现在会是 10/0）。
5. **线上**：`/admin/keys` 显示 `pool:"keys", configured:2`；watchdog ④ 转绿；一次真实检索 + 一次 AI 总结正常。
6. 单测全绿（当前 **640**）+ `tsc` 0 错；**新增守卫**：`POOL_KEYS_*` 与旧变量混配时的去重与优先级。

---

## 5. 需要你确认的 4 个取舍

| # | 取舍 | 我的建议 |
|---|---|---|
| 1 | **合并范围**：embed + rerank + llm 合成一个池 | ✅ 按你说的做；`RERANK_POOL_KEYS` 保留为可选覆盖（不影响默认行为）|
| 2 | **过渡期兼容**：代码同时读新旧变量并去重（你可以"先加新的、验证后再删旧的"）| ✅ 强烈建议（否则你改名的那一刻线上会 0 把 key → 全部降级）|
| 3 | **ref 命名**：`POOL_KEYS_3` → `pool-key-3`（用你填的数字，稳定）| ✅ 推荐；不要求数字连续 |
| 4 | **禁用语义**：禁用一把 key = **全能力禁用**（不再按能力分开禁）| ✅ 合并后唯一合理的语义 |

_创建：2026-09-12 · 待确认后实施_
