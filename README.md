<h1 align="center">dsh-router-codebuddy</h1>

<p align="center">dsh-router 的 CodeBuddy 供应商插件</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-router-codebuddy"><img src="https://img.shields.io/npm/v/dsh-router-codebuddy?style=flat-square&logo=npm&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#快速安装">快速安装</a> ·
  <a href="#能力">能力</a> ·
  <a href="https://github.com/CARVIN94/dsh-router#readme">dsh-router 核心</a>
</p>

为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 `codebuddy` 供应商（OAuth 轮询登录，OpenAI 兼容网关）。
单独装它没用——它只是向核心注册一个供应商，面板、账号池、组合回退都在核心里。

## 快速安装

先装核心，再装本插件，然后**重启 `dsh web`**：

```bash
dsh plugin --profile web add dsh-router-core
dsh plugin --profile web add dsh-router-codebuddy
```

`dsh plugin add` 会在 profile 里 `pnpm add`，并自动把声明了 `dsh.bundle.patch`
的包加入 `dsh.profile.bundles`（本插件即声明了，即 `cordis.patch.yml`）。

重启后本插件以 cordis service `router.suppliers` 向 dsh-router 注册 `codebuddy`
供应商，面板「供应商」出现 CodeBuddy 卡片。

> 本地开发版：不用 npm，直接 `dependencies` 加
> `"dsh-router-codebuddy": "link:/path/to/dsh-router-codebuddy"` 指向本地仓库。

## 能力

| 能力 | 说明 |
|---|---|
| OAuth 轮询登录 | 生成登录链接 → 浏览器登录 → 后台轮询 token（每 5s，最多 5 分钟），自动落盘凭证。无粘贴回调步骤。 |
| 模型列表 | 「获取模型」从上游 `GET /v3/config` 实时拉取（带账号 token，服务端下发，GLM-5.3 / Kimi-K3 这类新模型上游一上线就能刷出来）；上游不可达时回退内置兜底表；仍可手动添加自定义模型。 |
| 连接池 | 多账号由核心按池顺序/策略（`fallback` / `round-robin`）选号回退，本插件只报告单个账号的成败与语义状态。 |
| token 自动刷新 | 到期前 24 小时内用 refresh token 刷新（`X-Refresh-Token` 头），刷新失败继续用旧 token。 |
| 签到领积分 | 每日 100 积分（连续第 7 天 1000），核心遍历所有链接逐个调用。已签到上游返回 `code=10001`（HTTP 400 + 该码），幂等视为成功。 |
| 积分显示 | 面板账号积分 = `get-user-resource` 各额度包的**剩余**求和（`CapacityRemain`，会续期的基础包取 `CycleCapacityRemain`），10 分钟缓存，签到后自动刷新。注意 `TotalDosage` 是**累计已消耗**，不是剩余。 |

## 使用

1. 重启 `dsh web`
2. 面板 → 供应商 → CodeBuddy 卡片 → 添加链接 → 浏览器登录 → 完成添加

新增的 CodeBuddy 账号会出现在面板账号池中；模型在供应商详情页点「获取模型」从上游
拉取（列表随服务端下发更新，无需升级插件），仍可手动添加自定义模型。
`/v1/chat/completions` 请求模型可写 `glm-5.3-flash` 或带别名前缀
`codebuddy/glm-5.3-flash`（插件自动剥前缀）。

> **模型从哪来**：`GET https://copilot.tencent.com/v3/config` —— CodeBuddy 官方客户端
> 取云端产品配置的同一接口。它不鉴权也返回 200，但 `data.models` 只有在带账号
> accessToken 时才下发；所以必须**先添加链接再点获取模型**，没账号时只会拿到内置兜底表。
> 回包里的生图/视频模型（`tags` 含 `text-to-image` 等）走不了 `/v2/chat/completions`，
> 会被过滤掉。

## 与核心的分工

本插件只管**对单个账号调通上游**：OAuth 协议、token 刷新、SSE 转换、签到、积分。

**策略全在核心**（`AccountPool`）：选号、冷却、禁用、连续错误累计、遍历回退、
响应写入。所以：

- `chatOnce(uid, req)` 一次只服务一个账号，**不遍历账号、不维护冷却表、不写响应**
- 失败时返回语义状态（`rate_limit` / `quota` / `session_dead` / `unavailable` /
  `transport` / `unknown`），由核心决定冷却多久、是否禁用、要不要换号
- `status()` 只报「现在状态」（凭证 + 积分），冷却/禁用由核心叠加后给面板

完整契约见 [dsh-router 的 `docs/suppliers.md`](https://github.com/CARVIN94/dsh-router/blob/main/docs/suppliers.md)。

## 上游

- **chat**：`POST /v2/chat/completions`（强制流式，非流式上游拒绝；转成 OpenAI SSE 交回核心写，成败与语义状态报给核心换号）
- **模型**：`GET /v3/config` → `data.models[]`（`id` / `maxInputTokens` / `tags`）；不鉴权也 200 但 `models` 为 null，必须带账号 token
- **登录**：`POST /v2/plugin/auth/state` 生成链接 → 浏览器登录 → 轮询 `GET /v2/plugin/auth/token?state=...`（每 5s，最多 5 分钟）换 token 落盘
- **刷新**：`POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token` 头，到期前 24 小时内触发）
- 凭证：`auths/codebuddy/{uid}.json`（`{nickname, accessToken, refreshToken, expiresAt}`）

## 架构

通过 cordis service `router.suppliers` 的**共享聚合表**向 dsh-router 注册 `codebuddy`
供应商工厂（cordis 每个 service name 只允许一个插件 `provide`，本插件 `inject` 等其它
插件先提供该表后追加并广播 `internal/service` 触发重扫，与加载顺序无关）。

```
src/
  index.ts     插件入口（host 半，通过 cordis service router.suppliers 暴露供应商工厂表）
  plugin.ts    codebuddy 供应商实现（OAuth 登录、单账号 chat、token 刷新）
  contract.ts  供应商契约（自含，与 dsh-router 契约同步）
  types.ts     通用类型（SupplierStatus / ChatRequest 等）
cordis.patch.yml  bundle patch，把插件插入 DSH cordis bundle stack
```

## 开发

```bash
pnpm install
pnpm build        # lib/index.js
pnpm typecheck
```

## 致谢

- [decolua/9router](https://github.com/decolua/9router) —— codebuddy-cn（open-sse）实现的参考来源。

## 许可证

[MIT](LICENSE)
