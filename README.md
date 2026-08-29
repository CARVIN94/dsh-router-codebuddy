# dsh-router-codebuddy

DSH 插件：为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 `codebuddy` 供应商（OAuth 登录，OpenAI 兼容网关）。

参考 [decolua/9router](https://github.com/decolua/9router) 的 codebuddy-cn 实现（open-sse），为 dsh-router 提供差异化供应商能力。

## 功能

- **OAuth 轮询登录**：生成登录链接 → 浏览器登录 → 后台轮询 token（每 5s，最多 5 分钟），自动落盘凭证
- **内置模型列表**：上游无公开 models 接口，模型列表取自 WorkBuddy.app（CodeBuddy 官方桌面客户端）的 product.json + 9router 实际使用记录，只保留各系列最新版本（DeepSeek-V4 / GLM-5.2 / MiniMax-M3 / Kimi-K2.7 / Hy4+Hy3 / Hunyuan-2.0），面板「可用模型」自动出现；仍可在面板手动添加自定义模型
- **连接池**：多账号由 dsh-router 核心按池顺序/策略（`fallback` / `round-robin`）选号回退；本插件只报告单个账号的成败与语义状态，冷却/禁用/连续错误累计都由核心处置
- **token 自动刷新**：到期前 24 小时内用 refresh token 刷新（`X-Refresh-Token` 头），刷新失败继续用旧 token
- **签到领积分**：面板「签到」由 dsh-router 核心遍历所有链接逐个调用，每日 100 积分（连续第 7 天 1000）；已签到上游返回 `code=10001`（HTTP 400 + 该码），幂等视为成功
- **积分显示**：面板账号积分 = `get-user-resource` 各额度包的**剩余**求和（`CapacityRemain`，会续期的基础包取 `CycleCapacityRemain`），10 分钟缓存，签到后自动刷新。注意 `TotalDosage` 是**累计已消耗**，不是剩余

## 安装(DSH)

先装核心 [dsh-router-core](https://github.com/CARVIN94/dsh-router)(dsh-router 仓库,提供面板 + 内置供应商),再装本插件:

```bash
dsh plugin --profile web add dsh-router-core
dsh plugin --profile web add dsh-router-codebuddy
```

`dsh plugin add` 会在 profile 里 `pnpm add`,并自动把声明了 `dsh.bundle.patch`
的包加入 `dsh.profile.bundles`(本插件即声明了,即 `cordis.patch.yml`)。

然后**重启 `dsh web`**。本插件以 cordis service `router.suppliers` 向 dsh-router
注册 `codebuddy` 供应商,面板「供应商」出现 CodeBuddy 卡片。

> 本地开发版:不用 npm,直接 `dependencies` 加
> `"dsh-router-codebuddy": "link:/path/to/dsh-router-codebuddy"` 指向本地仓库。

## 目录

```
src/
  index.ts     插件入口（host 半，通过 cordis service router.suppliers 暴露供应商工厂表）
  plugin.ts    codebuddy 供应商实现（OAuth 登录、单账号 chat、token 刷新）
  contract.ts  供应商契约（自含，与 dsh-router 契约同步）
  types.ts     通用类型（SupplierStatus / ChatRequest 等）
cordis.patch.yml  bundle patch，把插件插入 DSH cordis bundle stack
```

## 使用

1. 重启 `dsh web`
2. 面板 → 供应商 → CodeBuddy 卡片 → 添加链接 → 浏览器登录 → 完成添加（轮询式登录，无粘贴回调步骤）

新增的 CodeBuddy 账号会出现在面板账号池中；模型列表已内置（自动出现在面板「可用模型」），仍可手动添加自定义模型。`/v1/chat/completions` 请求模型可写 `glm-5.2` 或带别名前缀 `cbcn/glm-5.2`（插件自动剥前缀）。

## 上游

- **chat**：`POST /v2/chat/completions`（强制流式，非流式上游拒绝；转成 OpenAI SSE 交回核心写，成败与语义状态报给核心换号）
- **登录**：`POST /v2/plugin/auth/state` 生成链接 → 浏览器登录 → 轮询 `GET /v2/plugin/auth/token?state=...`（每 5s，最多 5 分钟）换 token 落盘
- **刷新**：`POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token` 头，到期前 24 小时内触发）
- 凭证：`auths/codebuddy/{uid}.json`（`{nickname, accessToken, refreshToken, expiresAt}`）

## 架构

通过 cordis service `router.suppliers` 的**共享聚合表**向 dsh-router 注册 `codebuddy` 供应商工厂（cordis 每个 service name 只允许一个插件 `provide`，本插件 `inject` 等其它插件先提供该表后追加并广播 `internal/service` 触发重扫，与加载顺序无关）。只实现差异化能力（登录 / **单账号** chat / token 刷新 / 签到 / 积分）。

分工边界：`chatOnce(uid, req)` 一次只服务一个账号，**不遍历账号、不维护冷却表、
不写响应**——选号、冷却、禁用、连续错误累计、响应写入全是 dsh-router 核心
`AccountPool` 的活。同理，签到也是核心遍历所有链接、本插件只签一个 uid。

## 构建

```bash
pnpm install
pnpm build        # lib/index.js
pnpm typecheck
```

## License

MIT