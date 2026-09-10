// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — Cloudflare Pages 同源反向代理：/api/* → 后端 Worker
//
// ── 这个文件为什么存在（GFW 背景，见 TODO.md §P0）──
// 后端 Worker 的公众地址是 `*.workers.dev`，而 **`*.workers.dev` 被 GFW 封锁**。
// 前端 `https://search.chengxi.moe`（Pages 自定义域，墙内可访问）能打开，
// 但浏览器直连 Worker 的搜索 / 登录 / AI 流式请求会全部失败——
// 墙内用户看到的是「页面能开、搜不出东西、点登录没反应」，且 OAuth 回调是浏览器顶层跳转，
// 会在回调那一步被墙拦死，永远登不上。
//
// 于是把 `/api/*` 交给本 Pages Function 反代到 Worker：
//   浏览器 → https://search.chengxi.moe/api/*  →  本函数（Pages Functions）
//          → https://transhelper-prism-backend.transprism.workers.dev/api/*
// 浏览器从此**只与自有域名通信**：同源、无跨域、不再暴露 workers.dev；
// Worker 只被「服务端到服务端」的 fetch 访问，墙拦不到。
//
// ── 不变量（改动前先读，全是踩坑换来的）──
// 1. 路径**不能**去掉 `/api` 前缀：Worker 的 Hono 路由就挂在 `/api/v1/...` 上（history §5 坑 18）。
// 2. 请求体**流式**透传（`request.body`），绝不 `await request.text()`：会破坏大 body / 丢流式，
//    还白吃 CPU+内存配额（免费版 10ms/128MB，history §5 坑 13）。
// 3. 上游 3xx **不跟随**（`redirect: "manual"`）：OAuth 授权页跳转、回调带 `#token=` 回前端
//    都必须原样交给浏览器自己跳。
// 4. SSE（`/api/v1/search/stream`）直接把上游 `response.body` 当新 Response 的 body 回传：
//    不读成文本、不改写、不加缓冲类头，且**不能**用 30s 超时把它掐断（history §5 坑 22）。
// 5. 相对 `Location` 必须补成绝对地址再回，否则浏览器会按「当前域」解析（history §5 坑 30）。
// 6. 这里**不加任何 CORS 头**：同源之后浏览器不再需要跨域；上游 Worker 自己的 CORS 中间件照旧处理。
// 7. **`cf-connecting-ip` 必须删掉、并用真实客户端 IP 覆盖式写 `x-forwarded-for`**：
//    子请求里的 `cf-connecting-ip` 是 CF 内部地址，后端限流优先读它 → 会把所有用户归进同一个桶。
//    详见 `forwardedRequestHeaders` 的注释；改动前先读那段。
//
// ── 编译方式 ──
// 本文件由 Pages 的 Functions 构建（esbuild）单独编译，**不参与** `nuxt generate`
// （Nuxt 只扫 pages/components/composables/layouts/middleware/plugins/utils/server，`functions/` 不在其中）；
// 但 `.nuxt/tsconfig.json` 的 include 是 `../**/*`，所以它**会**被 `npm run typecheck` 检查，
// 必须严格模式（strict）可编译。

// ─────────────────────────────────────────────────────────────────────────────
// 平台类型（最小等价声明）
// ─────────────────────────────────────────────────────────────────────────────
// 本仓库 frontend/ 的 devDependencies 里**没有** `@cloudflare/workers-types`，
// 且本任务**不允许新增任何 npm 依赖** —— 所以这里给出与平台结构等价的最小类型。
// 该文件本身是模块（有 export），下面这些声明都是模块作用域，不会污染全局，
// 也不会和将来可能安装的 `@cloudflare/workers-types` 全局声明冲突。
// 若将来该包进了 devDeps，可换成：import type { PagesFunction } from "@cloudflare/workers-types"

/** Pages 环境变量绑定。 */
interface Env {
  /**
   * 可选：覆盖上游 Worker 的 base URL（例：`https://api.example.com`）。
   * 缺省用下面的 `DEFAULT_API_ORIGIN` —— 上游地址**不是**唯一硬编码点，但也不用它放任何敏感信息：
   * 这里只允许放「上游 base URL」，绝不放 key / secret（那份信息只活在 Worker Secrets 里）。
   */
  API_ORIGIN?: string
}

/** Pages Function 的调用上下文（与 `EventContext` 同形；字段取真实平台类型里那几个必有的）。 */
interface PagesContext<Bindings> {
  request: Request
  env: Bindings
  params: Record<string, string | string[]>
  data: Record<string, unknown>
  functionPath: string
  waitUntil: (promise: Promise<unknown>) => void
  passThroughOnException: () => void
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>
}

/** 与 `@cloudflare/workers-types` 的 `PagesFunction` 同形的最小声明。 */
type PagesFunction<Bindings = unknown> = (context: PagesContext<Bindings>) => Response | Promise<Response>

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 缺省上游：后端 Worker（workers.dev 在墙内不可达，所以只允许服务端到服务端访问它）。 */
const DEFAULT_API_ORIGIN = "https://transhelper-prism-backend.transprism.workers.dev"

/** 普通请求超时 30s（线上搜索 P50 ≈ 1.5–3s，含 rerank/LLM 也远小于 30s）。 */
const TIMEOUT_MS = 30_000

/** SSE 请求超时 120s：**绝不能**沿用 30s，否则长回答的流会在中途被 abort 掐断。 */
const STREAM_TIMEOUT_MS = 120_000

/**
 * 转发请求时要剔除的头：
 * - `host`：必须删！否则上游会按「Pages 的 Host」处理（虚拟主机/路由都可能错）。
 * - `accept-encoding`：故意删掉，交由运行时协商。上游响应可能是 gzip/br，而我们在响应侧
 *   必须删 `content-encoding`（避免 CDN 二次压缩错乱），所以**必须确保拿到的 body 已解码**
 *   （Workers 运行时对自己协商的压缩会透明解压；把浏览器那份 `gzip, deflate, br, zstd`
 *   原样递上去反而可能拿到未解压的字节，删了 `content-encoding` 就会变成乱码）。
 * - 其余是标准 hop-by-hop 头（逐跳，不该跨代理转发）。
 */
const DROPPED_REQUEST_HEADERS: readonly string[] = [
  "host",
  "accept-encoding",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
]

/**
 * 回传响应时要剔除的头：
 * - `content-encoding`：避免 CDN 二次压缩错乱（上游已解码，或我们已按上面的规则拿到解码后的 body）。
 * - `content-length`：body 可能是流（SSE/大响应）且长度已不等于原值，交给运行时按需决定。
 * - 其余为 hop-by-hop 头。
 */
const DROPPED_RESPONSE_HEADERS: readonly string[] = [
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "trailer",
]

/** 这些状态码不允许带 body（带上会在构造 Response 时抛错）。 */
const NULL_BODY_STATUS: readonly number[] = [101, 204, 205, 304]

/** OAuth 回调路径（`/api/v1/auth/oauth/<provider>/callback`），见下面的绝对地址修正特例。 */
const OAUTH_CALLBACK_PATH_RE = /\/auth\/oauth\/[^/]+\/callback$/

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

/** 解析上游 origin：env 覆盖优先，非法/空值静默回落缺省（代理挂掉 = 前端全站不可用，宁可打到已知可用的上游）。 */
function resolveUpstreamOrigin(env: Env): string {
  const raw = typeof env?.API_ORIGIN === "string" ? env.API_ORIGIN.trim() : ""
  if (!raw) return DEFAULT_API_ORIGIN
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return DEFAULT_API_ORIGIN
    return parsed.origin
  } catch {
    return DEFAULT_API_ORIGIN
  }
}

/**
 * 是否需要按「长连接流式」对待。
 * 判定用 accept 头（前端 `searchStream` 明确发了 `Accept: text/event-stream`），
 * 再兜一条路径后缀（手写 curl 调试时常常不带 accept，别因此被 30s 掐断）。
 */
function isStreamRequest(request: Request, pathname: string): boolean {
  const accept = request.headers.get("accept") ?? ""
  if (accept.toLowerCase().includes("text/event-stream")) return true
  return pathname.endsWith("/stream")
}

/**
 * 透传请求头：整份复制 + 剔除上面那张表（保留 `authorization` / `content-type` / `accept`）。
 *
 * ── 客户端 IP 的处理（线上踩过，务必别改回去）──
 * Pages Function → Worker 是「Worker 到 Worker 的子请求」，CF 会给子请求塞一个**内部地址**
 * 作为 `cf-connecting-ip`（实测 `2a06:98c0:3600::103`），而后端限流优先读的就是它 ——
 * 结果所有匿名用户被归到同一个桶（`RATE_LIMIT_IP_PER_MIN` 变成全站共享额度）。
 *
 * 所以这里必须：
 *   1. **删掉** `cf-connecting-ip` / `x-real-ip`，让后端回落到 `x-forwarded-for`；
 *   2. **覆盖式**写入 `x-forwarded-for` = 本请求的真实客户端 IP
 *      （`request.headers.get("cf-connecting-ip")` 是 CF 边缘写在**入站请求**上的，浏览器伪造不了，
 *       因此不能"仅当不存在时才写"——那会让客户端自带 XFF 生效，等于给限流开了后门）；
 *   3. 客户端自带的 `x-forwarded-for` 也会被第 2 步覆盖。
 *
 * 直连 `workers.dev` 的场景不受影响：CF 仍会写真实 `cf-connecting-ip`，后端优先用它，
 * 所以「伪造 XFF 绕过限流」在两条路径上都不成立。
 */
function forwardedRequestHeaders(request: Request): Headers {
  const headers = new Headers(request.headers)
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name)

  // 入站请求上的真实客户端 IP（CF 边缘写入，浏览器无法伪造）
  const clientIp = request.headers.get("cf-connecting-ip")

  // 先清掉"谁在调用我"这类头，再按上面的规则重建
  headers.delete("cf-connecting-ip")
  headers.delete("x-real-ip")
  headers.delete("x-forwarded-for")
  if (clientIp) headers.set("x-forwarded-for", clientIp)

  return headers
}

/**
 * 请求体：**流式**透传，绝不读成文本（见文件头不变量 2）。
 * GET/HEAD 不带 body；其余（POST/PUT/PATCH/DELETE…）原样交出 `request.body`，
 * 无 body 时为 `null`，fetch 会自己处理。
 * 注意：workerd 不需要（也不该加）Node/undici 那个 `duplex: "half"`。
 */
function requestBody(request: Request): ReadableStream<Uint8Array> | null {
  if (request.method === "GET" || request.method === "HEAD") return null
  return request.body
}

/** 多个 `Set-Cookie` 必须逐个取；运行时没有 `getSetCookie` 时退回单值读取。 */
function readSetCookies(source: Headers): string[] {
  const maybe = source as Headers & { getSetCookie?: () => string[] }
  if (typeof maybe.getSetCookie === "function") return maybe.getSetCookie()
  const single = source.get("set-cookie")
  return single ? [single] : []
}

/** 逐条透传上游响应头（保留 content-type / cache-control），按上面的表剔除。 */
function forwardedResponseHeaders(source: Headers): Headers {
  const out = new Headers()
  source.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (DROPPED_RESPONSE_HEADERS.includes(lower)) return
    // Set-Cookie 单独走 append：用 forEach 会把多个 cookie 逗号合并成一条（语义就坏了）
    if (lower === "set-cookie") return
    out.set(key, value)
  })
  for (const cookie of readSetCookies(source)) out.append("set-cookie", cookie)
  return out
}

/** 判断 Location 是否为相对引用（无 scheme、也不是 `//host` 这种协议相对）。 */
function isRelativeLocation(location: string): boolean {
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(location) && !location.startsWith("//")
}

/**
 * 把上游的 `Location` 补成绝对地址再回给浏览器（history §5 坑 30）。
 *
 * - 绝对地址 / 协议相对地址：按上游 origin 解析，等价于原样透传。
 * - 相对地址：**按上游 origin** 解析（标准反代语义，nginx `proxy_redirect` 同款）。
 * - 特例（唯一一处有意偏离「一律按上游 origin」）：OAuth 回调里的相对 Location。
 *   回调发生在 `https://search.chengxi.moe/api/v1/auth/oauth/x/callback`，此时上游若回
 *   `/login/#token=…` 这类相对路径，它想跳的是**前端页面**；而「前端在哪」只有浏览器侧的域名知道
 *   （上游 origin 是 workers.dev —— 墙内不可达，补成上游域就等于把用户跳进黑洞，登录彻底失效）。
 *   后端本来就已经改成回绝对 URL（`auth.ts` 的 `sanitizeRedirect` / `loginRedirectUrl`，坑 30 的修法），
 *   这里只是把「万一又回退成相对」的后果从「登录失败」降级为「照常登录」。
 */
function absolutizeLocation(location: string, upstreamUrl: URL, incomingUrl: URL): string {
  if (!location) return location
  try {
    if (isRelativeLocation(location) && OAUTH_CALLBACK_PATH_RE.test(incomingUrl.pathname)) {
      return new URL(location, incomingUrl).toString()
    }
    return new URL(location, upstreamUrl).toString()
  } catch {
    // 解析不了就原样回（宁可让浏览器自己报错，也不要凭空造一个地址）
    return location
  }
}

/** 泛化错误响应：**不泄漏上游地址/拓扑**，也不带任何 CORS 头。 */
function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 处理器
// ─────────────────────────────────────────────────────────────────────────────

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const incoming = new URL(request.url)
  const upstream = new URL(resolveUpstreamOrigin(env))

  // 路径 + 查询串**原样**透传（`/api/v1/search?x=1` → 上游 `/api/v1/search?x=1`，**不剥 `/api`**）。
  // ⚠️ 不要写成 `new URL(pathname + search, origin)`：以 `//` 开头的 pathname 会被当成
  //    「协议相对 URL」解析到**别的主机**（等于开了个 SSRF/开放代理口子）。
  //    用 pathname/search 赋值既安全，又能保持百分号编码原样（URL 不会二次编码 `%XX`）。
  upstream.pathname = incoming.pathname
  upstream.search = incoming.search

  const streaming = isStreamRequest(request, incoming.pathname)

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(upstream, {
      method: request.method,
      headers: forwardedRequestHeaders(request),
      body: requestBody(request),
      // 3xx 不跟随：手动把 status + Location 回给浏览器，由浏览器自己跳（OAuth 授权页 / 回调回前端）。
      // Pages/Workers 的 manual 会返回真实的 3xx（不是浏览器那种 opaque-redirect），Location 可读。
      redirect: "manual",
      // 超时：普通 30s；SSE 120s（见常量注释，绝不能用 30s 掐断流）。
      signal: AbortSignal.timeout(streaming ? STREAM_TIMEOUT_MS : TIMEOUT_MS),
    })
  } catch {
    // 网络异常 / DNS 失败 / 超时 / 上游拒连：统一 502 泛化错误（不回显上游地址细节）。
    return jsonError(502, "upstream-unreachable")
  }

  // 理论上不会走到（Workers 的 manual 给的是真实 3xx）；真要出现 opaque-redirect（status 0）
  // 就没法拿到 Location 了，此时按上游异常处理，而不是让 Response 构造抛错变成 500。
  if (upstreamResponse.status < 200 || upstreamResponse.status > 599) {
    return jsonError(502, "upstream-unreachable")
  }

  const headers = forwardedResponseHeaders(upstreamResponse.headers)

  // 相对 Location → 绝对地址，避免浏览器按 Pages 域/上游域解析错（history §5 坑 30）。
  const location = upstreamResponse.headers.get("location")
  if (location !== null) headers.set("location", absolutizeLocation(location, upstream, incoming))

  // OPTIONS 不做特殊处理：整体透传（同源理论上不会发预检，保留透传以免将来跨域场景踩坑）。
  // 204/304 等「禁止带 body」的状态码必须传 null body，否则构造 Response 会抛。
  if (upstreamResponse.body === null || NULL_BODY_STATUS.includes(upstreamResponse.status)) {
    return new Response(null, { status: upstreamResponse.status, headers })
  }

  // SSE / 大响应：把上游 body 这个流**直接**交给新 Response（不读文本、不改写、不加缓冲类头），
  // 这样首 token 就能到浏览器，CF 不会「憋一大坨再吐」（history §5 坑 22）。
  // statusText 故意不复制：上游可能给出非 ASCII/异常 reason phrase，set 进 Response 会抛 RangeError。
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers })
}
