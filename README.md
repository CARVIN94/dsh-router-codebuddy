<h1 align="center">dsh-router-codebuddy</h1>

<p align="center">dsh-router 的 CodeBuddy 族供应商插件（国内 CodeBuddy + 国际版 WorkBuddy）</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-router-codebuddy"><img src="https://img.shields.io/npm/v/dsh-router-codebuddy?style=flat-square&logo=npm&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本：0.2.0+" src="https://img.shields.io/badge/DSH-0.2.0%2B-4d6bfe" /></a>
</p>

<p align="center">
  <a href="#快速安装">快速安装</a> ·
  <a href="#两个供应商">两个供应商</a> ·
  <a href="#能力">能力</a> ·
  <a href="https://github.com/CARVIN94/dsh-router#readme">dsh-router 核心</a>
</p>

为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供腾讯 CodeBuddy 族的**两个**供应商
（OAuth 轮询登录，OpenAI 兼容网关）。单独装它没用——它只是向核心注册供应商，面板、账号池、
组合回退都在核心里。

## 两个供应商

| 供应商 id | 面板名 | 上游 | 别名前缀 |
|---|---|---|---|
| `codebuddy` | CodeBuddy | `copilot.tencent.com`（国内版） | `codebuddy/` |
| `codebuddy-en` | CodeBuddyEN | `www.workbuddy.ai`（WorkBuddy 国际版） | `codebuddy-en/` |

WorkBuddy 是腾讯的**国际版 AI 办公工作台**，与国内 CodeBuddy **同族同契约**：同样的
OAuth 轮询登录、同样的 `/v2/chat/completions` 网关、同样的 `/billing/meter/*` 签到积分。
因此两者共用同一份实现（`src/core.ts`），差异只落在各自的 profile 上：

```
src/
  core.ts       共享实现 —— OAuth 登录、单账号 chat、token 刷新、签到、积分、模型拉取、
                11128 重试阶梯
  body.ts       出站请求体归一 —— 接口归一（developer/tool_choice/system 头）、
                内容指纹按句改写、WAF 外壳剥离、11128 重试用的中性头与零宽散点
  cn.ts         codebuddy profile    （copilot.tencent.com：/v2 单路径、CLI 指纹头）
  en.ts         codebuddy-en profile （www.workbuddy.ai：/console→/v2 回退、桌面端指纹头、WAF 净化）
  index.ts      插件入口（host 半，一次注册两个供应商）
  contract.ts   供应商契约（自含，与 dsh-router 契约同步）
  types.ts      通用类型（SupplierStatus / ChatRequest 等）
cordis.patch.yml  bundle patch，把插件插入 DSH cordis bundle stack
```

## 快速安装

需要 **DSH `0.2.0` 及以上**（核心已单面 0.2.0，0.1.x 宿主不再支持）。先装核心，再装本插件，然后**重启 `dsh web`**：

```bash
dsh plugin --profile web add dsh-router-core
dsh plugin --profile web add dsh-router-codebuddy
```

`dsh plugin add` 会在 profile 里 `pnpm add`，并自动把声明了 `dsh.bundle.patch`
的包加入 `dsh.profile.bundles`（本插件即声明了，即 `cordis.patch.yml`）。

重启后本插件以 cordis service `router.suppliers` 向 dsh-router 注册两个供应商，
面板「供应商」出现 CodeBuddy 与 CodeBuddyEN 两张卡片。

> 本地开发版：不用 npm，直接 `dependencies` 加
> `"dsh-router-codebuddy": "link:/path/to/dsh-router-codebuddy"` 指向本地仓库。

## 能力

| 能力 | 说明 |
|---|---|
| OAuth 轮询登录 | 生成登录链接 → 浏览器登录 → 后台轮询 token（每 5s，最多 5 分钟），自动落盘凭证。无粘贴回调步骤。 |
| 模型列表 | 「获取模型」从上游 `GET /v3/config` 实时拉取（带账号 token，服务端下发，新模型上游一上线就能刷出来）；上游不可达时回退内置兜底表；仍可手动添加自定义模型。 |
| 接口归一（两个供应商） | chat 出站前 `developer` → `system`、`tool_choice` 对象形态 → string、首条非 system 时前置兜底 system —— 规避上游 `11128 first message is not system prompt` / `11101 Unmarshal chat params failed`。国内网关**同样**会拿 11128 拒 DSH 自己的 system 开场白，所以归一两侧都跑。 |
| 内容指纹按句改写 | **出站前无条件跑**：把上游实测拒收的那几句 DSH 提示词换成同义措辞（identity / coding agent / Web GUI / `Agent Teams` / `@` 路径段逐句）。为什么不是零宽扰动：CN 网关匹配前会**规范化掉不可见字符**，`root\u200b` 这类插法仍 400/11128，只有真改词才 200（2026-10-29 本机实测：同一账号改写后 200、原文 400）。为什么按句：`@` 路径段是**组合**指纹（逐句单发都 200、整段一起 400），且实测最小触发跨度只有该段前 112 字，所以行必须细到句子。没命中任何一行时返回入参原文，逐字节不变。 |
| 11128 重试阶梯 | 改写之后仍被渠道闸拒绝（`Illegal API invocation from an unapproved channel`）时，在**同一个号**上继续换请求形态重试，最多三级：原样 → 把被禁开场白挪到 `You are a helpful assistant.` 之后 → 在句读/词边界插零宽空格。每级只在确实改了字节时才发；三级都被拒才报 `bad_request`（请求级，不判账号死）。**注意第三级对「规范化零宽」的网关无效**，它是给不规范化、只做精确子串匹配的老规则留的；真正修掉这一族的是上面那层改写。 |
| 会话身份头 | chat 每请求现生成 `X-Conversation-ID` / `-Request-ID` / `-Message-ID`（官方客户端特征；缺了会撞 11128「不是官方客户端」那一支）。 |
| 连接池 | 多账号由核心按池顺序/策略（`fallback` / `round-robin`）选号回退，本插件只报告单个账号的成败与语义状态。 |
| token 自动刷新 | 到期前 24 小时内用 refresh token 刷新（`X-Refresh-Token` 头），刷新失败继续用旧 token。 |
| 签到领积分 | 每日 100 积分（连续第 7 天 1000），核心遍历所有链接逐个调用。**先读 `checkin-activity-status`**：`active=false`（该区没办活动）→ 报「未开放」不发写请求；`today_checked_in=true` → 报「已签到」并发刷新积分。真签发时上游回 `code=10001` 也当成功（幂等两条腿都在）。状态读失败一律 fail-open，照旧直接签。 |
| 积分显示 | 面板账号积分 = `get-user-resource` 各额度包的**剩余**求和：统一读 cycle 家族（`CycleCapacityRemain[Precise]`），月度资源用 `CapacityType === 4` 判定，已过期/已耗尽的赠送包不计。请求体带分页/产品码/状态/到期时间窗（发 `{}` 会漏包）。**企业号**读 `get-enterprise-user-usage`，剩余 = `limitNum − credit`（`credit` 是已消耗）。内存缓存 10 分钟，签到后自动刷新。注意 `TotalDosage` 是**累计已消耗**，不是剩余。积分的**持久化由核心统一做**（`supplier-config.json`），本插件拿不到时报 `-1` 让核心顶上次的值。 |

## 使用

1. 重启 `dsh web`
2. 面板 → 供应商 → CodeBuddy / CodeBuddyEN 卡片 → 添加链接 → 浏览器登录 → 完成添加

新增账号会出现在面板账号池中；模型在供应商详情页点「获取模型」从上游拉取
（列表随服务端下发更新，无需升级插件），仍可手动添加自定义模型。
`/v1/chat/completions` 请求模型可写 `glm-5.3-flash` 或带别名前缀
`codebuddy/glm-5.3-flash`（插件自动剥前缀）。

> **模型从哪来**：`GET <base>/v3/config` —— 官方客户端取云端产品配置的同一接口。
> 它不鉴权也返回 200，但 `data.models` 只有在带账号 accessToken 时才下发；所以必须
> **先添加链接再点获取模型**，没账号时只会拿到内置兜底表。回包里的生图/视频模型
> （`tags` 含 `text-to-image` 等）走不了 chat 端点，会被过滤掉。

## 上游

**国内 CodeBuddy**（`https://copilot.tencent.com`）：

- **chat**：`POST /v2/chat/completions`（强制流式，非流式上游拒绝；转成 OpenAI SSE 交回核心写）
- **模型**：`GET /v3/config` → `data.models[]`（`id` / `maxInputTokens` / `tags`）
- **登录**：`POST /v2/plugin/auth/state` 生成链接 → 浏览器登录 → 轮询 `GET /v2/plugin/auth/token?state=...` 换 token 落盘
- **刷新**：`POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token` 头，到期前 24 小时内触发）
- **积分/签到**：`POST /v2/billing/meter/get-user-resource`、`POST /billing/meter/daily-checkin`（404 回退 `/v2` 变体）、`POST /v2/billing/meter/checkin-activity-status`（只读预检）、`POST /billing/meter/get-enterprise-user-usage`（企业号余额）
- 凭证：`auths/codebuddy/{uid}.json`（`{nickname, accessToken, refreshToken, expiresAt}`）

**国际版 WorkBuddy**（`https://www.workbuddy.ai`）—— 与上面同契约，差异在路径与指纹：

- **chat**：`POST /console/chat/completions`，404/405 回退 `POST /v2/chat/completions`；出站前做接口归一（见上表）
- **积分/签到**：`POST /billing/meter/*`（无 `/v2` 前缀），404 回退 `/v2/billing/meter/*`；企业号另走 `/billing/meter/get-enterprise-user-usage`
- **出站指纹头**：UA `WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1`、同域 `Origin`/`Referer`、`Accept-Language: en-US`、`X-No-Enterprise-Id: 1`
- **WAF 净化**（仅国际侧）：剥掉 `confirm` / `whoami` 的命令替换外壳（见 issue #3）
- 凭证：`auths/codebuddy-en/{uid}.json`

## 与核心的分工

本插件只管**对单个账号调通上游**：OAuth 协议、token 刷新、SSE 转换、签到、积分。

**策略全在核心**（`AccountPool`）：选号、冷却、禁用、连续错误累计、遍历回退、
响应写入。所以：

- `chatOnce(uid, req)` 一次只服务一个账号，**不遍历账号、不维护冷却表、不写响应**
- 失败时返回语义状态（`rate_limit` / `quota` / `session_dead` / `unavailable` /
  `transport` / `unknown` / `no_such_model` / `bad_request`），由核心决定冷却多久、
  是否禁用、要不要换号。**`bad_request` = 请求本身被上游拒（参数错 / 图片认不出 /
  tool_call 配对断裂）**，同一个请求对池里每个号都会失败，所以核心不惩罚账号——
  否则一次坏请求会把整个池冷掉（2026-09-15 读图事故）。
- `status()` 只报「现在状态」（凭证 + 积分），冷却/禁用由核心叠加后给面板
- 积分只报**值**，不落盘：拿不到时报 `-1`（不是 0），核心保留上次持久化的值

### 上游业务码的归类（两类拒绝必须分清）

同一个 HTTP 状态里混着**账号级**和**模型级**两种拒绝，归错一类不是错个提示，而是
可用性损失——两类的处置方向相反：

| 业务码 | 含义 | 归类 | 为什么 |
|---|---|---|---|
| `11102` | `model [x] service info not found`：目录还列着、上游已下架 | `no_such_model` | **模型级**：2026-10-10 在全部 11 个 CN 账号上逐号实测，同一模型结果完全相同（11/11 号 400/11102），而 `glm-5.3` 同批 11/11 全 200。归 unknown 会逐号冷却、遍历全池才 503，与「模型不存在」的语义完全不符。 |
| `11103` | `Backend [x] is not supported`：生图模型被当聊天模型调 | `bad_request` | 同上，模型级、逐号一致。 |
| `11140` | `request illegal`（响应体带 `displayMsg`：未通过内容安全审核） | **不归类**，走默认 `403 → session_dead` | **账号级**，见下。 |
| `11128` / `11133` / `11135` | 首条非 system / 参数非法 / 图片认不出 | `bad_request` | 请求形态问题，与账号无关；国际侧 `11128` 已在出站前规避。 |

`11140` 的判据是**踩出来的**，别被它的文案骗了：它写着 "The content did not pass
the safety review."，看起来像内容审核（请求级），但实测同一段无害内容、甚至
**不带任何 user 消息（仅 system）**也一样被拒；而同一时刻同样请求换本机另外两个号
都能正常出字（`wb-1` → 403/11140，`wb-2`/`wb-3` → 200）。**它描述的是「这个账号被
风控」**，所以必须留在 `session_dead`（连接级冷却 30 分钟、到期自愈、**逐号换**）。
若误判成 `bad_request`，核心会跳过整个供应商，那两个可用号就永远轮不到。

同理，**不要把业务码的判定提到 HTTP 状态之前**：`403`/`429` 与请求级业务码组合时，
那一步会把「可以换号」变成「整个供应商被跳过」。

完整契约见 [dsh-router 的 `docs/suppliers.md`](https://github.com/CARVIN94/dsh-router/blob/main/docs/suppliers.md)。

## 架构

通过 cordis service `router.suppliers` 的**共享聚合表**向 dsh-router 注册两个供应商工厂
（cordis 每个 service name 只允许一个插件 `provide`，本插件 `inject` 等核心先提供该表后
追加并广播 `internal/service` 触发重扫，与加载顺序无关）。

两个供应商 id 即凭证与配置的存储键：凭证在 `credentials.sqlite`、配置与积分缓存在
`supplier-config.json`，均以 supplier id 寻址，故两个供应商各自独立、互不影响。

## 开发

```bash
pnpm install
pnpm build        # lib/index.js
pnpm typecheck
pnpm test         # 行为回归闸门（node --test）
```

`src/core.test.ts` 锁的是 **profile 边界**：国内侧不多发 system、不动 tool_choice、
只打 `/v2`；国际侧三个接口归一存在且顺序正确（补 system 必须在改 role 之后）；
端点回退只在 404/405 触发；两个 id / 存储键 / uid 前缀不变。改 profile 改错会直接变红。

## 致谢

- [decolua/9router](https://github.com/decolua/9router) —— codebuddy-cn（open-sse）实现的参考来源。
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) —— 国际版 WorkBuddy 的路径/指纹/接口归一参考。

## 许可证

[MIT](LICENSE)

## 免责声明

本项目仅用于学习与技术研究，请勿用于商业用途。
