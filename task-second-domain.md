# task-second-domain.md —— 第二前端域名 `search.transhelper.org`（待执行）

> 状态：**待执行**（2026-09-09 记录；当前卡在**权限**：需要 `transhelper.org` 所在 CF 账号的 DNS 修改权限）
> 关联：`plan-ratelimit.md` §8.1（委派已取消）、`history.md` 坑 17（跨账号 CNAME 1014/1016）、`TODO.md`
> 预计耗时：**10 分钟**（不含等证书）

---

## 1. 为什么做这个

`search.chengxi.moe` 是主域（`FRONTEND_BASE_URL`、OAuth 回跳、文档地址都用它）。
再加一个 `search.transhelper.org` 作为**抗封冗余**：哪天某个域名被墙，把用户导到另一个即可。

**关键结论：这件事不需要子域委派、不需要改任何代码。**
- 前端 `apiBase` 线上实测已是 **`/api`**（同源），所以第二个域名会**自动复用同一套 Pages Function 反代**；
- X 后台**不用改**（OAuth 回调固定走 `search.chengxi.moe/api/...`）；
- 内容与主域完全一致（同一份 Pages 产物 + 同一套 `/api` 反代）；
- 不额外收费。

---

## 2. 前置条件（缺一不可）

| # | 条件 | 归谁 |
|---|---|---|
| 1 | **transprism 账号**里 Pages 项目 `transhelper-prism` 的编辑权限 | 你（已有）|
| 2 | **持有 `transhelper.org` 的那个 CF 账号**的 DNS 修改权限 | ⚠️ **你当前没有 —— 这就是待办的原因** |
| 3 | `transhelper.org` 的 NS 已指向 Cloudflare | ✅ 已满足（实测 `carlos.ns.cloudflare.com` / `izabella.ns.cloudflare.com`）|

> 顺带说明：`transhelper.org` **不在** transprism 账号（已确认），所以无法用「同账号直接加自定义域」的捷径；
> 但这不影响本任务 —— Pages 自定义域**支持跨账号**，流程与当年的 `search.chengxi.moe` 完全一样。

---

## 3. 当前 DNS 现状（2026-09-09 用 DoH 实测，绕开本机 fake-IP）

| 名称 | 记录 | 说明 |
|---|---|---|
| `transhelper.org` | NS `carlos.ns.cloudflare.com` / `izabella.ns.cloudflare.com` | 父域在**另一个账号** |
| `search.transhelper.org` | CNAME → `search.chengxi.moe`（已代理）| **现在只是个指向主域的别名，需要改目标** |
| `search.chengxi.moe` | A `104.21.71.79` / `172.67.143.246`（已代理）| 主域，指向 Pages，工作正常 |

---

## 4. 操作步骤（⚠️ 顺序不能反）

### 第 1 步 · 先在 Pages 里添加自定义域（**必须先做**）

1. `dash.cloudflare.com` → 切到 **transprism** 账号
2. **Workers & Pages** → 点 **`transhelper-prism`**（**Pages 项目**，不是 Worker）
3. **Custom domains（自定义域）** → **Add custom domain** → 输入：
   ```
   search.transhelper.org
   ```
4. 它会显示「待验证 / Pending」并提示需要一条 CNAME 指向 `transhelper-prism.pages.dev`。
   **这是预期的**，继续第 2 步。

> ⚠️ **为什么必须先做这步**：反过来的话，另一账号里那条指向 Pages 的**已代理 CNAME** 会撞
> **Error 1014 `CNAME Cross-User Banned`**（严重时 1016）。当年做 `search.chengxi.moe` 就踩过这个坑（`history.md` 坑 17）。

### 第 2 步 · 到 `transhelper.org` 账号改 CNAME 目标

1. 切到**持有 `transhelper.org` 的账号** → 点进 `transhelper.org`
2. 左侧 **DNS → 记录 / Records** → 找到现有的 **`search`** 记录（当前 `CNAME → search.chengxi.moe`）
3. **编辑**它：

| 字段 | 改成 |
|---|---|
| 类型 | `CNAME`（不变）|
| 名称 | `search`（不变）|
| **目标 / Content** | **`transhelper-prism.pages.dev`** ← 只改这里 |
| 代理状态 | **已代理（橙云）** ← 保持 |
| TTL | 自动 |

4. 保存

### 第 3 步 · 等验证与证书

回 transprism → Pages → Custom domains 看 `search.transhelper.org`：状态应从「待验证」变为 **Active**（自动签发证书，几十秒到几分钟）。

---

## 5. 验证清单

**做完第 3 步后告诉我，我会跑这些**（你也可以自己跑）：

```bash
# 1) DNS 是否指对
curl -s -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=search.transhelper.org&type=CNAME'

# 2) 静态页
curl -s -o /dev/null -w '%{http_code}\n' https://search.transhelper.org/          # 期望 200
curl -s https://search.transhelper.org/ | grep -o '<title>[^<]*</title>'          # 期望 TransHelper Prism 标题

# 3) 同源反代是否自动生效（这是关键）
curl -s https://search.transhelper.org/api/v1/corpora | head -c 120               # 期望四库 JSON

# 4) 登录回跳白名单（未加之前会被拒）
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  'https://search.transhelper.org/api/v1/auth/oauth/x/start?redirect=https%3A%2F%2Fsearch.transhelper.org%2F'
```

### 我随后要做的收尾（1 行配置）

把 `https://search.transhelper.org` 加进 Worker 的 **`ALLOWED_ORIGINS`**（`backend-cf/wrangler.jsonc`），否则：

- 从第二个域名点登录 → 回跳地址不在白名单 → 被 `sanitizeRedirect` 打回 `search.chengxi.moe`（人会被"扔"到另一个域名，观感突兀）；
- 跨域场景下的 CORS 也会缺这个 origin。

> 现状验证：`/start` 里的 `redirect` 参数**必须**是白名单内 origin 才会被原样采用。

---

## 6. 回滚

删掉 `search.transhelper.org` 这条 Pages 自定义域即可；如果想恢复成"别名"，把第 2 步的 CNAME 目标改回 `search.chengxi.moe`。
**主域 `search.chengxi.moe` 全程不受影响**，本任务无停机风险。

---

## 7. 常见错误对照

| 现象 | 原因 / 处理 |
|---|---|
| **Error 1014 `CNAME Cross-User Banned`** | 先改了 DNS、后加自定义域 → 删掉那条 CNAME，**先在 Pages 加自定义域**，再建 CNAME |
| **Error 1016** | 同上（跨账号解析被拒）；也可能 CNAME 目标写成了别的 Pages 项目 |
| Custom domain 一直「待验证」 | CNAME 目标不是 `transhelper-prism.pages.dev`；或代理状态被关（应为**橙云**）|
| 页面能开但 `/api/*` 404 | 说明请求没走到 Pages Function：检查是不是访问了 `transhelper-prism.pages.dev` 之外的旧别名 |
| 证书报错 / `ERR_CERT_COMMON_NAME_INVALID` | 等 CF 签发（最长 15 分钟）；仍未好则删掉自定义域重新添加 |

---

## 8. 附录：为什么不再做 `api.*` 子域委派（已取消）

原计划是把 `api.chengxi.moe` 委派到 transprism 账号、让 Worker 直接承载 API（从而原生拿到真实客户端 IP）。
**取消原因**：

1. **CF 的「添加站点」硬性拒绝子域名** —— 输入 `api.chengxi.moe` 直接被拦：
   「Please ensure you are providing the root domain and not any subdomains」；两个父域也都不在 transprism 账号，没有同账号捷径。
2. **它要解决的问题已经解决** —— 委派唯一的功能收益是"Worker 看到真实 IP"，而 R2 的信任链
   （`x-prism-proxy` + `x-prism-client-ip`）已实测做到：`resolved_ip = 真实 IP`、`resolved_by = proxy-trusted`、真实 `country/asn`，
   分档限流正是靠它跑通（境外第 11 次 429、LLM 第 13 次 429）。
3. **反代开销可忽略**：同一路径经反代 4.63s vs 直连 4.62s；且委派后前端与 API 会变成**跨域**（CORS + 预检回来了），净收益更小。

> 将来若真要重做：把任一父域整体迁入 transprism 账号（会搬迁该域全部 DNS，成本高），或改用别的自有根域。

---

_创建：2026-09-09 · 待你拿到 `transhelper.org` 账号权限后执行_
