# T0.0 连通性实测 — 用户准备清单（T0-CHECKLIST.md）

> 依据 `plan.md §9.1 / §13` 与 `tasks.md T0.0`。**三方全通才开 T0.1；任一不通立刻停下重估，不许硬上。**

目标：确认 Cloudflare Workers → 硅基流动中国站（embedding / rerank / chat）连通 + P50 延迟，
并直连 Qdrant Cloud 免费集群写/读各一条，为后续检索链路铺路。

## 你需要准备什么

### 1) 硅基流动（SiliconFlow）key —— 必填
- 注册/登录硅基流动（中国站，`https://api.siliconflow.cn`），开通 **embedding + rerank + chat** 三个接口的额度。
- 在控制台创建 API key（形如 `sk-...`）。
- 准备验证的模型（均为硅基流动中国站托管）：
  - embedding：`BAAI/bge-m3`（`/v1/embeddings`）
  - rerank：`BAAI/bge-reranker-v2-m3`（`/v1/rerank`）
  - chat：`Qwen/Qwen3-8B`（`/v1/chat/completions`）
- **本次只用于本地/Worker 探测，key 只放环境变量或 wrangler secret，绝不提交仓库。**
- 用 T0.0 之前，先人工在硅基流动在线测试页确认三个接口都能调通，再进入脚本探测。

### 2) Qdrant Cloud 免费集群 —— T0.0 需建，供后续检索用
- 打开 `https://cloud.qdrant.io`，注册免费层账号，创建一个 cloud 集群。
- 记下 **URL**（形如 `https://xxxx.cloud.qdrant.io:6333`）与 **API Key**。
- 免费层规格需确认装得下两个 wiki（chunks × 1024 维）——`plan.md §13` 提到需先确认。
- T0.0 会在该集群内建一个临时 collection，写一条、读一条验证直连通。

### 3) wrangler login —— 部署/本地 dev 需要
- 安装并登录（一次性）：`npm i -g wrangler` → `wrangler login`（浏览器授权你的 CF 账号）。
- 或本地开发只需 `wrangler dev`（不强制登录；`wrangler deploy` / 创建 D1/KV/Queue 绑定才需要）。

## 键只放哪（安全底线）
| 项 | 存放位置 | 禁止 |
|---|---|---|
| 硅基流动 key | secrets（`wrangler secret put`）或本地 `.dev.vars` / 环境变量 | 仓库、日志、前端 |
| Qdrant key | secrets 或 `.dev.vars` | 仓库、日志 |
| 任意 key | 永不打印 / 永不回显 | 报错体、console、响应 |

## 怎么跑探测脚本

### 本地 CLI 探测（先用这个，最快）
```bash
cd backend-cf
npm install
# 写入本地环境变量（只读，不入库）—— 建议用一个 .env 且确保 .gitignore 已排除
export SILICONFLOW_API_KEY=sk-xxxx
export QDRANT_URL=https://xxxx.cloud.qdrant.io:6333
export QDRANT_API_KEY=your_qdrant_key
npm run probe            # 打 embed / rerank / chat 各 5 次，打印连通性 + P50
```
- 输出 `OK/FAIL + status + latency + p50`，覆盖三接口。
- 最小期望：三个接口都 `OK`，且能从中国区访问延迟在可接受范围（P50 低于 CF 默认 30s 超时即可；理想 < 2s）。

### 部署为独立 Worker 再测（检验真 Workers 出口连通性，更接近生产）
1. 新建一个独立 Worker 目录（可临时复用 `scripts/`），把 `probe-connectivity.ts` 作为 main。
2. `wrangler secret put SILICONFLOW_API_KEY` 注入 key。
3. `wrangler deploy` 后用浏览器/curl 访问：
   - `https://<worker>.workers.dev/?endpoint=embed&runs=5`
   - `.../?endpoint=rerank&runs=5`
   - `.../?endpoint=chat&runs=5`
4. 观察返回 JSON 的 `ok / p50Ms`。

> 关键：**一定要从真实 Workers 出口测一次**。若 Workers→硅基流动不通（超时/被断），
> 则 plan.md §9.1 的"全 CF 方案"塌，届时需回退国内云并重估（见 plan §9.1 / §13）。

### Qdrant 直连验证（本 Worker 后续接入）
- T0.0 另写最小逻辑：在 Qdrant 建 `probe_coll` → upsert 一条 1024 维向量 → 同向量 search 应命中自身。
- 这一步先手动确认 Qdrant Cloud URL+key 可用；深度接入留在 T0.3。

## 通过判定（T0.0 验收）
- [ ] 硅基流动 embedding OK + P50 记录
- [ ] 硅基流动 rerank OK + P50 记录
- [ ] 硅基流动 chat OK + P50 记录
- [ ] Qdrant Cloud 直连：建/写/读各一次成功
- [ ] 任一 **fail** → **停止**，记录原因，重估方案，**不得进入 T0.1**

## 变更控制
- 本清单只描述"人工准备 + 如何跑"，所有 key 与账号信息**留在你本地/secrets**，不回填到代码仓库。
- 探测结果（P50 数字、是否全通）记到 `plan.md` 或本目录下的运行记录（不含 key）。
