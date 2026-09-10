# TODO —— TransHelper Prism 待办与已知问题

> 本文件记录**尚未完成**的事项与已知缺陷。已完成的任务见 `tasks.md`；设计决策见 `plan.md`；踩坑与交接见 `history.md`。

---

## 🔴 P0：后端域名被 GFW 拦（M3 完成后立刻做）

**现状**：前端在 `https://search.chengxi.moe`（自定义域，墙内可访问），但后端在
`https://transhelper-prism-backend.transprism.workers.dev`——**`*.workers.dev` 被 GFW 封锁**。

**后果**：墙内用户能打开前端页面，但**搜索请求全部失败**（前端 → workers.dev 的跨域请求被墙）。
也就是说墙内用户看到的是「页面能开、搜不出东西」。

**目标**：**前端与后端都走自有域名**，彻底不暴露 `workers.dev`：

| 方案 | 做法 | 备注 |
|---|---|---|
| **A（推荐）同源反代** | 给 Pages 加一个 **Pages Function**（`frontend/functions/api/[[path]].ts`）把 `/api/*` 反代到 Worker；前端 `NUXT_PUBLIC_API_BASE` 改成 `/api`（同源，无跨域） | 浏览器只与 `search.chengxi.moe` 通信；顺带消掉 CORS 与第三方域暴露。注意 Pages Functions 要正确透传 **POST body、SSE 流式响应、请求头**（SSE 必须不缓冲） |
| **B Worker 自定义域** | 给 Worker 绑自定义域，如 `api.chengxi.moe` 或 `search-api.transhelper.org`，前端指向它 | `chengxi.moe` 在**另一个 CF 账号**下 → 需在 Worker 所在账号建 custom domain，再到该账号配 DNS（跨账号 CNAME 有 1014/1016 坑，见 `history.md` 坑 17）；`transhelper.org` 若在 Worker 账号下则最省事 |
| **C 双管齐下** | A 做同源反代 + B 给 Worker 绑域名（供外部调用/运维） | 最稳，但工作量最大 |

**改造清单（做的时候别漏）**：
1. `backend-cf/wrangler.jsonc` 的 `ALLOWED_ORIGINS`：若走 A，可收窄为前端域名（同源后其实不再需要跨域）
2. `frontend` 的 `NUXT_PUBLIC_API_BASE`（CF Pages 环境变量）：A → `/api`；B → 新域名 + `/api`
3. 登录回跳：`OAUTH_REDIRECT_URI`（X 后台登记的那个）与 `FRONTEND_BASE_URL` 跟随新域名调整
4. 若绑新域名，**X 开发者后台的 Redirect URI 必须同步改**（差一个字符就登录失败）
5. 改完实测：墙内网络（或 DoH 模拟）下 `search.chengxi.moe` 能搜出结果

**验收**：墙内用户打开前端 → 能正常搜索、能登录、能看 AI 总结。

---

## 🟡 P1：其它已知缺口

1. **`/admin/usage` 的每账号 `requests` / `llm_tokens_*`**：需要 `key_usage` 加 `account_id` 列并接线（**进行中**）。
2. **反滥用第二层**：CF 边缘 Rate Limiting 规则（零代码，优先）与 Turnstile 人机验证。
   **当前决策：刻意暂缓——被刷了再加**。现在匿名可用完整向量检索（`REQUIRE_LOGIN=0`），成本闸门只有 KV 限流（IP 10 次/分钟）。
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
