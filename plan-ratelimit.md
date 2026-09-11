# plan-ratelimit.md —— 按 IP 分档限流 + 5 小时配额窗口（设计稿）

> 状态：**设计稿，待评审后实施**（2026-09-09）
> 关联：`TODO.md` §P0（域名改造）、`plan.md` §6.1（风控）、`history.md` §5 坑 23/24/35
> 本文只描述设计与实施步骤，不含代码改动。

---

## 1. 要解决的问题（全部来自线上实测）

| 现象 | 实测证据 |
|---|---|
| 反代后 Worker **看不到真实客户端 IP** | 经 `search.chengxi.moe/api/*` 时 `cf-connecting-ip = 2a06:98c0:3600::103`（CF 内部地址），直连时才是我真实 IP |
| 反代后 Worker **拿不到客户端网络元数据** | `request.cf` 经反代时是 `asn=13335 / org=Cloudflare, Inc.`（子请求自己的），直连时是 `asn=16509 / Amazon Data Services Singapore`（真实）|
| **KV 限流实际失效** | 经反代连打 12 次 / 13 秒内**全部 200、零 429**；直连时同一套代码是 20 放行 / 5 拦截 |
| 根因 | CF 的 Worker→Worker 子请求会**重新注入** `cf-connecting-ip`（Function 里删不掉），且子请求**跨 colo** 分发 → KV 计数器各 colo 不收敛（KV 最终一致） |

结论：**现有「KV + 单一 IP 限额」的匿名限流已经不能作为成本闸门**，需要重做。

---

## 2. 目标 / 非目标

**目标**
1. 按调用者性质分档限流：**CN 家宽/移动放宽，机房与境外收紧**，登录用户最宽。
2. **不存 IP 明文**：只存不可逆摘要（HMAC），窗口过期即失去意义。
3. 恶意/异常流量**直接挡掉**（宁可拒绝，不要烧钱）。
4. 阈值全部 env 可调，默认值保守可收敛。

**非目标**
- 不做用户画像、不做行为分析、不做长期留存（合规与隐私考虑）。
- 不用它做计费（计费仍是 D1 配额，只对登录用户）。
- 不改检索链路语义（分档只影响"放行/拒绝"）。

---

## 3. 识别数据从哪来（关键约束）

| 数据 | 直连 Worker | 经 Pages 反代 |
|---|---|---|
| 真实客户端 IP | `cf-connecting-ip` ✅ | ❌ 是 CF 内部地址 |
| 真实 country / ASN | `request.cf` ✅ | ❌ 是子请求的（Cloudflare 自己）|
| 我们代理能拿到的 | — | ✅ Pages Function **入站请求**的 `cf-connecting-ip` 与 `request.cf`（CF 边缘按真实连接判定，**浏览器无法伪造**）|

**设计**：由 Pages Function 把真实元数据**连同共享密钥凭据**转发给后端：

```
x-prism-proxy:     <PROXY_SHARED_SECRET>     # 凭据：证明确实是我们的代理转发
x-prism-client-ip: 1.2.3.4                   # 真实客户端 IP
x-prism-country:   CN                        # 真实 country
x-prism-asn:       4134                      # 真实 ASN
x-prism-colo:      SIN                       # 可选
```

后端信任规则（**已实现的骨架**，见 `backend-cf/src/ratelimit.ts`）：
1. `x-prism-proxy` 与 `env.PROXY_SHARED_SECRET` **恒时比较相等** → 采信 `x-prism-client-ip` + `x-prism-country` + `x-prism-asn`；
2. 否则回落今天的逻辑：`cf-connecting-ip` → `x-forwarded-for` 首段（**直连场景不受影响**）。

为什么不会被伪造：
- 直连 `workers.dev` 的调用者**拿不到密钥**，其 `x-prism-*` 一律不采信；
- 经反代时，`cf-connecting-ip` / `request.cf` 由 CF 边缘按真实连接写入，客户端改不了；Function **先删后写**，客户端自带的同名头被覆盖。

> ⚠️ 未配密钥时整套退化为今天的行为（不报错）。**密钥需要两处同值**：Pages 项目 env + Worker secret。

---

## 4. 分档策略

| tier | 判定 | 默认限额（次/分钟） | 说明 |
|---|---|---|---|
| `logged_in` | 有效 JWT 会话 | **60** | 另有 5h 加权 token 配额精确计量（真正的成本闸门）|
| `cn_residential` | `country=CN` 且 ASN ∈ 家宽/移动白名单 | **30** | 目标主力用户：CN 家宽/移动网络通常较干净 |
| `cn_other` | `country=CN` 且 ASN 既不在白名单也不在 IDC 名单 | **15** | 保守中间档 |
| `cn_idc` | `country=CN` 且 ASN ∈ 云/IDC 名单 | **6** | 阿里云/腾讯云/华为云/UCloud/百度云…。**刻意低于境外**：正常人不会用机房 IP 连站，且机房 IP 是攻击主力（曾被打过）|
| `overseas` | `country≠CN` | **10**（可调 5）| 逼境外用户登录（登录后 60/min）。略高于 CN 机房，因为境外的正常读者（含海外华人）比机房攻击者多 |
| `unknown` | 取不到 country 或 ASN | **5** | 最保守；故障时宁可少放行 |

**env 变量**（全部可调，缺省用上表）：
```
RATE_LIMIT_LOGGED_IN_PER_MIN=60
RATE_LIMIT_CN_RESIDENTIAL_PER_MIN=30
RATE_LIMIT_CN_OTHER_PER_MIN=15
RATE_LIMIT_CN_IDC_PER_MIN=6
RATE_LIMIT_OVERSEAS_PER_MIN=10
RATE_LIMIT_UNKNOWN_PER_MIN=5
# LLM 端点限额 = ceil(对应搜索限额 / 该除数)——默认 5，可改 4
RATE_LIMIT_LLM_DIVISOR=5
```

### 4.0 LLM 端点单独收紧（同一个分档，除以除数后向上取整）
LLM（`/search/stream`、`/chat`）单次成本远高于纯检索，所以**复用同一套分档，只把限额除以 `RATE_LIMIT_LLM_DIVISOR`（默认 5）并向上取整**：

| tier | 搜索（次/分钟）| LLM（次/分钟）= `ceil(搜索/5)` |
|---|---|---|
| `logged_in` | 60 | **12** |
| `cn_residential` | 30 | **6** |
| `cn_other` | 15 | **3** |
| `cn_idc` | 6 | **2** |
| `overseas` | 10 | **2** |
| `unknown` | 5 | **1** |

- 下限保护：任何档位的 LLM 限额**至少 1**（不能因为取整变 0）。
- 现状说明：LLM 端点目前**要求登录**（未登录 401），所以该限额实际作用在 `logged_in` 档（60 → 12/min），
  且还有 5h 加权 token 配额做精确计量；公式保留是为了将来若放开匿名 AI 可直接生效。
- 搜索与 LLM **分别计数**（两个桶），互不占用对方的额度。

### 4.1 CN 家宽/移动 ASN 白名单（初始值，需按数据校准）
已知主要骨干，**先作为初始清单**：
- 中国电信：`4134`（CHINANET）、`4809`（CN2/CTGI）
- 中国联通：`4837`（CHINA169）、`9929`（CUII）
- 中国移动：`9808`（CMNET）、`56040`~`56048`（各省移动）、`24400`
- 教育网：`4538`（CERNET，校园网按非机房放宽）

**维护方式（重要）**：省级/地市 ASN 数以千计，不要手写。建议从公开数据生成一份只含「CN 非 IDC ASN」的清单（APNIC delegated 文件 / iptoasn 数据 + 按 `asOrganization` 关键词筛 `Chinanet|China Telecom|China Unicom|China Mobile|CMNET|CERNET|Broadband`，排除 `Cloud|Alibaba|Tencent|Huawei Cloud|IDC|Data Center`），落成 `backend-cf/src/data/cn-residential-asn.ts`（纯数据、随代码评审更新，可加脚本与来源说明）。

**IDC/云名单（收紧用）**：`45102`（阿里云）、`132203`（腾讯云）、`136907`（华为云）、`135377`（UCloud）、`55967`（百度）、`37963`（阿里云国际）、`45090`（腾讯）；境外常见：`16509`（AWS）、`15169`/`396982`（Google）、`8075`（Azure）、`14061`（DigitalOcean）、`20473`（Vultr）、`24940`（Hetzner）、`16276`（OVH）、`63949`（Linode/Akamai）、`31898`（Oracle）、`13335`（Cloudflare）。

> ⚠️ **白名单≠可信**：有 IDC 从电信 ASN 广播。白名单只表示"放宽一档"，真正的兜底是下面的熔断与配额。

---

## 5. 计数存哪（核心决策）

| 方案 | 跨 colo 一致性 | 成本 | 结论 |
|---|---|---|---|
| KV（现状）| ❌ 最终一致，实测失效 | 低 | **淘汰**（仅保留作"廉价近似值"，不做判定）|
| **D1 原子计数** | ✅ 单点一致 | 每请求 1 次写（免费 100k 写/天）| **推荐** |
| Durable Object | ✅ 强一致 | 需写 DO + 计费模型 | 备选（量大了再上）|
| Turnstile | —（不是计数，是"证明是人"）| 免费 | 可叠加，作为匿名 AI 的场景 |

### D1 表设计（草案）
```sql
CREATE TABLE IF NOT EXISTS rate_counters (
  bucket_key   TEXT PRIMARY KEY,   -- HMAC(secret, "tier|ip|window_index")，不含 IP 明文
  tier         TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_sec   INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_counters_window ON rate_counters (window_start);
```
- 原子自增：`INSERT ... ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1` + 回读，或用
  `UPDATE ... WHERE count < ?limit` 看 `meta.changes`（与 `quota.ts` 同一套写法，已经被并发测试验证过）。
- 全局计数：同一张表里放一行 `bucket_key = 'global:anon:<window_index>'`。
- 清理：窗口过期的行没有意义，可"每 N 次请求顺手删一批"或每日 cron 删 `window_start < now-1h`。

### 隐私（对齐「识别但不存储」）
- 表里**没有 IP 列**：`bucket_key` 是 `HMAC_SHA256(RATE_LIMIT_SECRET, tier|ip|window)` 的十六进制摘要。
- 没有密钥无法反推（不像裸 `sha256(ip)` 可被彩虹表穷举——IPv4 空间太小，**务必用 HMAC**，不要用裸哈希）。
- 窗口过期即无意义；`RATE_LIMIT_SECRET` 轮换会让所有计数器失效（可接受）。
- **审计日志、错误日志、admin 面板一律不得输出 IP**（`whoami` 是 admin 专用诊断，且只回 IP 本身，不回密钥）。

### 写放大与降级路径
- 默认（推荐先上）：**每次匿名 `/search` 写 1 行**。免费版 100k 写/天 ≈ 每天 10 万次匿名检索的上限——以当前流量足够；到顶说明该付费了（$5/月）。
- 可选优化（流量大了再做）：混合模式——KV 先近似计数，只有「接近限额」的 IP 才查 D1 做精确判定，把 D1 写入限定在少数重用户上。

---

## 6. 突发与熔断（用户要求「大流量直接崩」）

| 层 | 触发 | 动作 |
|---|---|---|
| 单 IP 突发 | 10 秒内 ≥ `BURST_PER_10S`（默认 20）| 429 + `Retry-After`，并在 D1 记 `block_until = now + 60s`（期间一律 429）|
| 全局匿名软熔断 | 匿名请求 > `ANON_GLOBAL_PER_MIN`（**线上已设 300**，代码默认 600）| 匿名**只给关键词回退**（不调 embedding/rerank，成本≈0），响应带 `warning` |
| 全局匿名硬熔断 | 匿名请求 > `ANON_GLOBAL_HARD_PER_MIN`（**线上已设 600**，代码默认 1200）| 匿名一律 429；登录用户不受影响 |
| LLM/追问 | 本就要求登录 | 由 5h 配额精确计量，无需另设 |

原则：**熔断只掐匿名**，登录用户（有配额、可追溯）保持可用；所有阈值 env 可调，默认从保守值起步。

---

## 7. 双层防线：CF 边缘规则 + Worker 逻辑

| 层 | 位置 | 看到什么 | 作用 |
|---|---|---|---|
| **边缘 Rate limiting rule** | zone `chengxi.moe`（WAF）| 真实客户端 IP / country / ASN | 在请求到达 Pages/Worker **之前**拦掉粗暴刷量 —— **连 Worker 与 embedding 成本都省掉** |
| **Worker 内分档计数** | `backend-cf` + D1 | 代理转发的真实 IP/country/ASN | 精细分档（§4）、熔断（§6）、与登录态联动 |

**边缘规则要点**：
- 免费版通常只允许 **1 条** 规则：先用一条粗粒度的 `/api/v1/search` + 按 IP + 10 秒窗口（阈值 20 次）Block 10 秒。
- 若要实现"CN 家宽 30 / 其它 10"的分档，需要在 Worker 内做（§4），或升级套餐用多条规则按 `ip.geoip.country` / `ip.geoip.asnum` 分流。
- 边缘规则命中时 Worker **零调用**，可直接用于验证是否生效（看 Worker 请求量是否掉下来）。

---

## 8. 域名与反代架构（澄清 + 决策）

**决策：保留现有的同源反代，不删。**

```
浏览器 ──https──▶ search.chengxi.moe（CF Pages，墙内可达）
                   ├── /            → 静态资源（Nuxt 预渲染产物）
                   └── /api/*       → Pages Function 反代 ─▶ Worker（workers.dev，墙内不可达）
```

- **前端静态资源确实不需要任何反代** —— 对，Pages 直接发静态文件。
- **但后端 API 必须挂在 `search.chengxi.moe` 下**（即 `/api/*` 这一段反代必须留）：`*.workers.dev` 被 GFW 封锁，
  浏览器若直连它，墙内用户搜索/登录全废 —— 这正是本次 P0 要解决的事。所以保留 `/api/*` 反代 = 保留墙内可用性。
- 反代的**副作用**（真实 IP/元数据丢失、KV 限流失效）已由 §3 的信任链 + §5 的 D1 计数解决。

### 8.1 ~~可选升级：委派 `api.*` / `search.*` 子域名~~ → ❌ **已取消（2026-09-09）**

> **取消原因（两条，任一条都足够）**
> 1. **CF 的「添加站点」硬性拒绝子域名**：实操时输入 `api.chengxi.moe` 直接被拦——
>    「Please ensure you are providing the root domain and not any subdomains」。
>    委派的前提（在目标账号新建子域 zone）在当前 CF UI 下走不通；而两个父域也都**不在** transprism 账号下（无同账号捷径）。
> 2. **委派要解决的问题已经解决**：它唯一的功能性收益是「Worker 看到真实客户端 IP」，
>    而 R2 的信任链（`x-prism-proxy` + `x-prism-client-ip`）**已经做到**——线上实测 `resolved_ip=真实 IP`、`resolved_by=proxy-trusted`、
>    真实 `country/asn`，分档限流正是靠它跑通。
>    且委派后前端与 API 会变成**跨域**（CORS + 预检回来了），净收益更小。
> 反代额外开销实测可忽略：同一路径经反代 4.63s vs 直连 4.62s。
>
> **若将来要重新考虑**：把任一父域（`chengxi.moe` / `transhelper.org`）整体迁入 transprism 账号，或保持现状使用 `*.pages.dev` 之外的第三方 DNS。

<details>
<summary>（原方案留档，勿再执行）</summary>

### 8.1 可选升级：把 `search.chengxi.moe` **子域名**单独委派过来（不必迁整个 `chengxi.moe`）

**可以做到**。做法是「子域名 NS 委派」（child zone delegation），`chengxi.moe` 主体与其它记录**不受影响**：

```
① 在 chengxi.moe 所在账号：给子域加一条 NS 委派
   search.chengxi.moe.  NS  <CF 给新 zone 分配的两个 ns>（如 kai.ns.cloudflare.com / pat.ns.cloudflare.com）
② 在 Worker 所在账号（transprism）：把 search.chengxi.moe 作为**新 zone** 添加
   → CF 校验委派生效后，该子域就成了本账号下的独立 zone
③ 在这个新 zone 里：
   · search.chengxi.moe  → 重新关联到 Pages 项目（custom domain）
   · api.search.chengxi.moe → 添加为 **Worker 自定义域**（Custom Domain）
④ 把前端 `NUXT_PUBLIC_API_BASE` 改成 https://api.search.chengxi.moe/api，
   并**删掉 Pages Function 反代**（frontend/functions/ 整个目录可移除）
```

**收益（为什么值得做）**
- Worker 直接承载 API → **看到真实客户端 IP 与真实 `request.cf`（country/asn）**，
  不再需要 `PROXY_SHARED_SECRET` 信任链、不再有"子请求元数据是 Cloudflare 自己"的问题；
- 少一跳（Pages Function），延迟更低、故障面更小；
- IP 分档限流变得**天然准确**，边缘限流规则也能直接按 country/ASN 分流。

**代价与坑（务必先读）**
1. **委派后 `search.*` 下的所有记录都由新 zone 管**：原来在 `chengxi.moe` 里为 `search` 建的 CNAME/其它记录要
   在新 zone 里重建（含 Pages 自定义域关联），漏了就是那段解析失效。
2. **迁移期间有短暂断服**（NS 生效 + 证书签发，通常几分钟到几十分钟）。
3. 新 zone 会占用一个 zone 配额（免费版可加多个 zone，但**子域名 zone 需要能通过 CF 的 NS 校验**——
   在父域加 NS 记录这一步必须在 `chengxi.moe` 账号操作，你要有那个账号的访问权）。
4. Pages 自定义域当前是跨账号关联（history 坑 17 的 1014/1016）：委派后应**先在新 zone 重新添加**，
   确认 200 后再删旧关联，避免中间态解析悬空。
5. `api.search.chengxi.moe` 与 `search.chengxi.moe` 都自动走 CF 证书，无需自备。

**更省事的替代（如果它成立）**：若 `transhelper.org`（或任何你**已经在 transprism 账号里**的域名）
可用，直接加一条 Worker 自定义域 `api.transhelper.org` 即可 —— **不用任何委派**，同样能达到"Worker 直接见真实 IP"的效果。
优先级建议：**同账号域名 > 子域委派 > 保持现状（反代 + 信任链）**。

> 现状（反代 + `PROXY_SHARED_SECRET` 信任链 + D1 计数）本身是**可用**的，上面属于优化项，不是阻塞项。

</details>

### 8.2 子域名 NS 委派 · 操作手册（❌ 已取消，见 §8.1；以下仅作历史留档）

**当前真实 DNS 状态**（用 DoH 查的，绕开本机 fake-IP）：

| 名称 | 记录 | 结论 |
|---|---|---|
| `chengxi.moe` | NS `colin.ns.cloudflare.com` / `lady.ns.cloudflare.com` | 父域在**另一个 CF 账号** |
| `transhelper.org` | NS `carlos.ns.cloudflare.com` / `izabella.ns.cloudflare.com` | 又是另一组 NS → **大概率也不在 transprism 账号** |
| `search.chengxi.moe` | A → `104.21.71.79` / `172.67.143.246`（CF 代理）| 指向 Pages（跨账号 custom domain）|
| `search.transhelper.org` | **CNAME → `search.chengxi.moe`** | 当前只是个别名 |

**先做一步判断**：登录 CF → 右上角切换账号 → 看 **Websites（域）** 列表里有没有 `chengxi.moe` / `transhelper.org`。
- **有**（即父域就在 transprism 账号）→ **不用委派**，直接跳到「第 3 步」加自定义域即可。
- **没有** → 按下面委派。

#### 方案 A（推荐，零停机）：委派 `api.*` 兄弟子域，完全不碰现有 `search.*`

```
① transprism 账号：添加两个站点（zone）
     api.chengxi.moe
     api.transhelper.org
   → 各记下 CF 分配的**两个 NS 名称**（zone 会先处于 Pending，正常）

② 在 chengxi.moe 所属账号：DNS → 记录 → 新增
     类型 NS   名称 api   内容 <api.chengxi.moe 的第一个 NS>
     类型 NS   名称 api   内容 <api.chengxi.moe 的第二个 NS>
   在 transhelper.org 所属账号：同样给 名称 api 加两条 NS（指向 api.transhelper.org 的 NS）
   ✅ 这两个名字**原本没有记录**，所以加 NS 不会影响任何现存服务 → 前端零停机

③ 等 zone 变 Active（几分钟；用 `dig NS api.chengxi.moe @1.1.1.1` 验证委派已生效）

④ transprism 账号里加自定义域（zone 已同账号，可直接加）
     Worker：Workers & Pages → transhelper-prism-backend → Settings → Domains & Routes
             → Add → Custom Domain → api.chengxi.moe（再重复一次 api.transhelper.org）
     Pages ：保持现状不动（search.chengxi.moe 仍是跨账号 custom domain，能用就别动）

⑤ 应用侧改动（我来做）
     NUXT_PUBLIC_API_BASE = https://api.chengxi.moe/api
     OAUTH_REDIRECT_URI   = https://api.chengxi.moe/api/v1/auth/oauth/x/callback  ← 并去 X 后台登记
     ALLOWED_ORIGINS      = https://search.chengxi.moe,https://search.transhelper.org
     删除 frontend/functions/（反代与信任链都不再需要）
```

#### 方案 B（你原本问的）：委派整个 `search.*` 子域

把 `search.chengxi.moe` / `search.transhelper.org` 各自变成一个 zone，前端与 API **全部**归 transprism 账号（最"干净"，但**有停机**）：

```
① transprism：添加 zone  search.chengxi.moe 与 search.transhelper.org → 记下各自的 NS 对
② 父域账号：DNS → 记录
     · **删除** search 上现有的记录（`search.chengxi.moe` 现在那条 CNAME/A）  ← ⚠️ 从这里开始前端断服
     · 新增两条 NS：名称 search → 两个 NS 名称
   （`search.transhelper.org` 同理：它在 transhelper.org 里是 CNAME 到 search.chengxi.moe，也要删掉换成 NS）
③ 等 zone Active（此时前端可能已经断了）
④ transprism 里重建：
     · Pages 自定义域  search.chengxi.moe（同账号，直接加，CF 自动建记录）
     · Pages 自定义域  search.transhelper.org
     · Worker 自定义域 api.search.chengxi.moe / api.search.transhelper.org
⑤ 应用侧：API 基址可用 https://api.search.chengxi.moe/api（更"整齐"），其余同方案 A
```

**方案 A vs B**

| | A（委派 `api.*`）| B（委派 `search.*`）|
|---|---|---|
| 停机 | **无** | 有（NS 生效 + 证书签发，几分钟~几十分钟）|
| 要动现有 `search.*` 记录 | 不用 | 要删要重建 |
| 最终域名 | `api.chengxi.moe` + `search.chengxi.moe`（前端不变）| `api.search.chengxi.moe` + `search.chengxi.moe`（同账号）|
| 风险 | 低 | 中（漏建记录就解析悬空）|

> **两者收益相同**：Worker 拿到真实客户端 IP 与真实 `request.cf`（country/asn），可删掉 Pages Function 反代与共享密钥信任链。

#### 8.2.1 零基础逐步操作（方案 A：委派 `api.*`，第一次做照着点即可）

**名词先对齐**：CF 里「**添加站点 / Add a site**」= 在这个账号下新建一个「zone（域）」。
委派就是：**在父域里加两条 NS 记录，把子域的管理权交给另一个账号新建的那个 zone**。

---

**第 0 步 · 先搞清楚两个父域分别在哪个账号（1 分钟）**

`dash.cloudflare.com` → 右上角**账号切换器** → 分别切到各账号 → 看左侧 **「域 / Websites」** 列表：

| 看到什么 | 结论 |
|---|---|
| `transhelper.org` **已经**在 `transprism` 账号里 | 它**不需要委派**，跳到第 4 步直接加 Worker 自定义域 |
| 不在 | 按下面完整流程做（和 chengxi.moe 一样）|

> 建议**先只做 `api.chengxi.moe` 一个**，跑通后再做第二个 —— 出问题好定位。

---

**第 1 步 · 在 transprism 账号里新建子域 zone**

1. 切到 **`transprism`** 账号
2. 左侧「**域 / Websites**」→ 右上「**添加站点 / Add a site**」
3. 输入 **`api.chengxi.moe`** → Continue
4. 选 **Free** 套餐 → Continue
5. 它会扫描 DNS 记录（子域一般没有记录，直接 Continue）
6. **最后屏幕会给出两个 nameserver 名字**，形如：
   ```
   xxxx.ns.cloudflare.com
   yyyy.ns.cloudflare.com
   ```
   👉 **把这两个名字复制下来/记下来**（第 2 步要用）。如果这页没看到，就在该 zone 的 **Overview** 页找「Cloudflare nameservers」。
7. 此时这个 zone 显示 **Pending（待激活）** —— **这是正常的**，因为我们还没做委派。

---

**第 2 步 · 去 chengxi.moe 所在账号加两条 NS 记录**

1. 切到**持有 `chengxi.moe` 的那个账号**
2. 点进 **`chengxi.moe`** → 左侧 **「DNS」→「记录 / Records」**
3. ⚠️ **不要动 `search` 那条记录**（它正跑着你的前端）
4. 点「**添加记录 / Add record**」两次，分别填：

| 类型 | 名称 | 内容 | TTL |
|---|---|---|---|
| `NS` | `api` | 第 1 个 nameserver | 自动 |
| `NS` | `api` | 第 2 个 nameserver | 自动 |

> 名称**只填 `api`**（CF 会自动补全成 `api.chengxi.moe`）；内容就是第 1 步复制的那两个名字。
> 如果原来就有 `api` 这个名的 A/CNAME 记录，要先删掉那条（我们没用过 `api`，一般不会遇到）。

---

**第 3 步 · 等激活**

回 transprism 账号看 `api.chengxi.moe`：状态应从 **Pending** 变成 **Active（活动）**（通常几分钟）。
超过 10 分钟还没变，告诉我 —— 我用 `dig NS api.chengxi.moe @1.1.1.1` 帮你判断委派有没有生效。

---

**第 4 步 · 把 Worker 挂到这个域名上**

1. transprism → **Workers & Pages** → `transhelper-prism-backend`
2. **Settings → Domains & Routes（域与路由）→ Add → Custom Domain**
3. 输入 **`api.chengxi.moe`** → Add
4. 等它变成 Active（CF 自动签证书，几十秒到几分钟）

---

**第 5 步 · 告诉我，我收尾**

我做：改 `NUXT_PUBLIC_API_BASE` / `OAUTH_REDIRECT_URI` / `ALLOWED_ORIGINS`，删除 `frontend/functions/` 反代，复测搜索 + 登录 + AI 流式。

**你要做**：X 开发者后台加一条 Redirect URI：
```
https://api.chengxi.moe/api/v1/auth/oauth/x/callback
```
（**原来的那条不要删**，留作回滚。）

---

**常见问题**
- 「这个域名看起来是子域」的提示 → 正常，继续。
- zone 一直 Pending → 检查父域那两条 NS 记录的**名称是不是 `api`**、内容是不是第 1 步给的两个名字。
- 加自定义域报 1014/1016 → 说明 zone 还没 Active，先等激活再加。
- 想回滚 → 删掉父域那两条 NS 记录即可（`api.*` 从未承载过线上流量，**无停机风险**）。

#### ⚠️ 共同注意事项
1. **删反代后前端与 API 变成跨域**（`search.chengxi.moe` → `api.chengxi.moe`）：CORS 与 OPTIONS 预检回来了，
   需把 `ALLOWED_ORIGINS` 配好；换来的是 Worker 直连（少一跳、限流天然准确）。
2. **X 后台的 Redirect URI 必须同步改**，否则登录直接失败。
3. 子域 zone 需要一个 zone 配额（免费版可加多个 zone，一个账号下多 zone 无额外费用）。
4. 委派后该子域下**所有**记录都由新 zone 管：父域里为它设的记录一律失效。
5. 建议低峰期做；做完让我用 `dig` + `curl` 验证委派、证书、前后端连通性。

---

## 9. 5h 配额窗口：错峰机制、锚定方式与重置提示

### 9.1 现状（已实现，回答「怎么保证每个用户不一样」）
`quotas.period_start` 的写入时机只有两处（`backend-cf/src/quota.ts`）：
1. 首次使用时 `INSERT OR IGNORE ... VALUES (accountId, nowMs, ...)`；
2. 窗口已过期（`period_start <= now - 5h`）时 `UPDATE ... SET period_start = now`。

**所以窗口起点 = 每个用户自己的请求时刻，不是全局整点 → 天然错峰**，不存在"统一重置挤爆"。
（这也回答了你的疑问：不是靠额外机制，而是本来就按人记录。）

**但有两个副作用**：
- 🔸 **窗口会漂移**：过期后不是从"过期那一刻"续算，而是从"下一次请求的时刻"重算。用户 3 天不来，新窗口就从 3 天后的首次请求开始。
- 🔸 **重置时刻不可预测** → 无法给用户显示"还有多久重置"（只能显示当前窗口的剩余，且用户一活跃就变）。

### 9.2 建议改成「按注册时间的网格锚定」
```
window_start = registration_time + floor((now - registration_time) / window_ms) * window_ms
```
- **完全可预测**：注册于 19:07 的用户，永远在每天的 00:07 / 05:07 / 10:07 / 15:07 / 20:07 重置；
- **仍然错峰**：由注册时间分散度决定（比"全局整点"好得多；若担心邀请码集中发放，可在注册时间上加一个随机偏移 `0..window_ms` 一并存库）；
- **不漂移**：长时间不活跃也不会改变重置时刻；
- **迁移**：一次性把现有行的 `period_start` 对齐到该用户的网格起点并清零 `used_cost`（线上目前只有 1 个真实账号，代价≈0）。
- 实现位置：`quota.ts` 的 `ensureWindow()`（把"过期才重置"改成"始终对齐当前网格窗口"），`used_cost` 仍需在跨窗口时清零。

### 9.3 「还有多久重置」的展示（TODO 项）
- `GET /api/v1/me` 的 `quota` 增加：`window_end`(ms)、`reset_at`(ms)、`reset_in_sec`(number)。
- 前端顶栏：额度百分比旁显示「x 小时后重置」；`/settings` 显示窗口起止与下次重置时刻（本地时区）。
- 额度耗尽时提示改成「额度已用尽，将于 x 小时后（HH:MM）恢复」，而不是现在的"约 x 小时后恢复"。

---

## 10. 实施阶段（每步可独立验收）

| 阶段 | 内容 | 谁做 | 预估 |
|---|---|---|---|
| **R1** | CF 边缘限流规则（1 条粗粒度）| 你（Dashboard）| 5 分钟 |
| **R2** | 两处设置 `PROXY_SHARED_SECRET`；代理转发 `country/asn/colo`；whoami 复测 `resolved_by=proxy-trusted` | 你（secret）+ 我（代码已备）| 10 分钟 |
| **R3** | D1 `rate_counters` 表 + 分档判定 + 原子计数（含迁移与清理）| 我（可派 subagent）| 半天 |
| **R4** | 突发熔断 + 全局软/硬熔断（env 可调）| 同上 | 2 小时 |
| **R5** | 观测：`/admin/usage` 增「今日匿名请求数 / 各档命中数 / 熔断次数」；被限流时的前端友好提示 | 同上 | 半天 |
| **R6** | 5h 窗口网格锚定 + `/me` 返回重置时间 + 前端显示（§9.2/9.3）| 同上 | 2 小时 |
| **R7**（可选）| 混合计数（KV 近似 + D1 精确）省写放大；Turnstile 兜匿名 AI | 待定 | 1 天 |

---

## 11. 验收标准

1. **分档生效**：CN 家宽 IP 第 31 次/分钟 → 429；境外第 11 次 → 429；**CN 机房第 7 次** → 429；登录用户第 61 次 → 429（且配额照常扣减）。
2. **LLM 收紧生效**：登录用户第 13 次 LLM 请求/分钟 → 429（`ceil(60/5)=12`）；搜索计数与 LLM 计数互不影响。
2. **不存 IP**：`rate_counters` 表内无任何明文 IP（抽查 + 单测断言）；审计日志与错误日志不含 IP。
3. **失效防护**：未配 `PROXY_SHARED_SECRET` 时行为与今天一致；伪造 `x-prism-*` / `X-Forwarded-For` 一律不采信（已有单测）。
4. **熔断**：全局软熔断触发后匿名只拿到关键词回退（上游 embedding 调用量为 0）；硬熔断后匿名 429、登录用户仍可用。
5. **边缘规则**：命中期间 Worker 请求量下降（可用 CF 分析或 Worker 日志验证）。
6. **重置可预测**：给定注册时间，`reset_at` 与手算网格一致；跨窗口后 `used_tokens` 归零。
7. 全量测试与 `tsc --noEmit` 保持全绿（当前基线 404 用例）。

---

## 12. 风险与开放问题

1. **ASN 清单准确性**：家宽白名单需要数据支撑（§4.1），初期误判会把正常用户降到 15/min —— 建议先按保守值上线，观察 `/admin/usage` 的档位分布再调。
2. **D1 写放大**：匿名每次检索 1 写，免费额度 100k/天；若接近上限需上 R7 的混合模式或升套餐。
3. **VPN 用户**：境外/机房档 10/min，是**有意的**（促其登录）。你自己的账号请用登录态（60/min + 配额）。
4. **边缘规则免费版只有 1 条**：分档只能在 Worker 内做；若将来要边缘分档需升级套餐。
5. **`PROXY_SHARED_SECRET` 泄漏的影响**：拿到密钥者可伪造 `x-prism-client-ip` 绕过 IP 限流 → 密钥只放 CF Secrets，不写进任何仓库文件；轮换成本低。
6. **窗口网格锚定**：需要一次数据迁移（对齐 `period_start` + 清零 `used_cost`），线上仅有 1 个真实账号，风险极低。

---

> ⚠️ **软/硬熔断不能设成同值**：硬熔断先扣名额（`count < hard` 失败即 429），软熔断要 `count > soft` 才降级 —— 同值会让“优雅降级带”消失、超限直接全站匿名 429。2026-09-11 用户要求“上限收到 600”，故设 **软 300 / 硬 600**。

_最后更新：2026-09-09（限流 R2✅ R3✅ R4✅ R5✅ R1⏸；子域委派 ❌ 因 CF 限制取消；新增第二前端域名 `search.transhelper.org`）_
