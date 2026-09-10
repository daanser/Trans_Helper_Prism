# `frontend/functions/` — Pages 同源反代（GFW 绕行）

> 背景与完整方案：仓库根 `TODO.md` §P0「后端域名被 GFW 拦」。踩坑背景：`history.md` §5（坑 18 / 22 / 30）。

## 为什么有这层

后端 Worker 挂在 `*.workers.dev` 上，而 **`*.workers.dev` 被 GFW 封锁**：墙内用户能打开
`https://search.chengxi.moe`（Pages 自定义域），但浏览器直连 Worker 的搜索 / 登录 / AI 流式全部失败
（OAuth 回调还是浏览器顶层跳转，会在回调那一步被拦死）。

```
浏览器  →  https://search.chengxi.moe/api/*   （同源，墙内可达）
        →  本目录的 Pages Function 反代
        →  https://transhelper-prism-backend.transprism.workers.dev/api/*  （服务端到服务端，不经墙）
```

## 路由

- `functions/api/[[path]].ts` → 匹配 `/api`、`/api/...`（CF Pages 的 `[[path]]` 是可选 splat，可跨多段，
  但**不要**用 `context.params.path` 拼 URL，直接取 `request.url` 的 pathname/search 最忠实）。
- 路径与查询串**原样**透传，**不剥 `/api` 前缀**（Worker 的 Hono 路由就挂在 `/api/v1/...` 上）。
- 其余路径不经过 Functions（仍是 Pages 静态资源），所以不需要额外的 `_routes.json`。

## 运维须知（改这个目录前先读 `[[path]].ts` 文件头的不变量）

| 项 | 行为 | 备注 |
|---|---|---|
| 上游地址 | 缺省硬编码 `DEFAULT_API_ORIGIN` | 可用 Pages 环境变量 **`API_ORIGIN`** 覆盖（只放 base URL，绝不放 key/secret） |
| 超时 | 普通请求 30s；`accept: text/event-stream` 或路径以 `/stream` 结尾 → 120s | **SSE 不能用 30s**，否则流被中途掐断 |
| 3xx | `redirect: "manual"`，status + `Location` 原样回给浏览器 | 相对 `Location` 会被补成绝对地址（history 坑 30） |
| 请求体 | 流式 `request.body` 透传 | 绝不 `await request.text()`：破坏大 body 且白吃 10ms/128MB 配额（坑 13） |
| SSE | 上游 `response.body` 直接作为新 Response 的 body | 不读文本、不改写、不加缓冲头（坑 22） |
| 剔除的请求头 | `host`、`accept-encoding`、逐跳头 | `host` 必须删；`accept-encoding` 删掉是为了保证拿到已解码 body |
| 剔除的响应头 | `content-encoding`、`content-length`、逐跳头 | 避免 CDN 二次压缩错乱 / 长度与流不符 |
| CORS | **不添加任何 CORS 头** | 同源后浏览器不再需要；上游 Worker 自己的 CORS 中间件照旧 |
| 错误 | 上游不可达/超时 → `502 {"error":"upstream-unreachable"}` | 不回显上游地址细节 |

## 相关配置（不在此目录，改动时一起看）

- CF Pages 环境变量：`NUXT_PUBLIC_API_BASE=/api`（同源；`useApi` 缺省本身就是 `/api`）。
- 后端 Worker：`OAUTH_REDIRECT_URI=https://search.chengxi.moe/api/v1/auth/oauth/x/callback`，
  且 **X 开发者后台的 Redirect URI 必须同步加这条**（差一个字符登录就失败）。
- 回滚：删掉/停用本目录，或把 `NUXT_PUBLIC_API_BASE` 改回 Worker 完整地址（会立刻回到「墙内不可用」状态）。

## 本地无法验证

本机 `wrangler` 子命令全坏（history 坑 27），**起不了 Pages 本地环境**：本层只能靠
「代码正确性 + `npm run typecheck`（`.nuxt/tsconfig.json` 的 include 覆盖了本目录）+ 部署后 curl 实测」
保证。部署后的线上验证清单见交接报告（普通 GET / 带查询串 / POST JSON / 302 透传 / SSE 流式 / 上游不可达）。
