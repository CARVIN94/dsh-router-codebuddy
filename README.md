# dsh-router-codebuddy

DSH 插件：为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 `codebuddy` 供应商（OAuth 登录，OpenAI 兼容网关）。

参考 [decolua/9router](https://github.com/decolua/9router) 的 codebuddy-cn 实现（open-sse），为 dsh-router 提供差异化供应商能力。

## 功能

- **OAuth 轮询登录**：生成登录链接 → 浏览器登录 → 后台轮询 token（每 5s，最多 5 分钟），自动落盘凭证
- **模型由 dsh-router 统一管理**：上游无公开 models 接口，插件不内置模型列表——核心缓存 `listModels` 结果，用户在面板「可用模型」手动添加自定义模型
- **连接池**：多账号按池顺序/策略（`fallback` / `round-robin`）回退，失败冷却 60s
- **token 自动刷新**：到期前 24 小时内用 refresh token 刷新（`X-Refresh-Token` 头），刷新失败继续用旧 token

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
  plugin.ts    codebuddy 供应商实现（OAuth 登录、chat 代理、token 刷新、连接池）
  contract.ts  供应商契约（自含，与 dsh-router 契约同步）
  types.ts     通用类型（SupplierStatus / ChatRequest 等）
cordis.patch.yml  bundle patch，把插件插入 DSH cordis bundle stack
```

## 使用

1. 重启 `dsh web`
2. 面板 → 供应商 → CodeBuddy 卡片 → 添加链接 → 浏览器登录 → 完成添加（轮询式登录，无粘贴回调步骤）

新增的 CodeBuddy 账号会出现在面板账号池中；模型需在面板「可用模型」添加（如 `glm-5.2`）后启用，`/v1/chat/completions` 请求模型可写 `glm-5.2` 或带别名前缀 `cbcn/glm-5.2`（插件自动剥前缀）。

## 上游

- **chat**：`POST /v2/chat/completions`（强制流式，非流式上游拒绝；失败冷却 60s 按池换号回退，透传 SSE）
- **登录**：`POST /v2/plugin/auth/state` 生成链接 → 浏览器登录 → 轮询 `GET /v2/plugin/auth/token?state=...`（每 5s，最多 5 分钟）换 token 落盘
- **刷新**：`POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token` 头，到期前 24 小时内触发）
- 凭证：`auths/codebuddy/{uid}.json`（`{nickname, accessToken, refreshToken, expiresAt}`）

## 架构

通过 cordis service `router.suppliers` 的**共享聚合表**向 dsh-router 注册 `codebuddy` 供应商工厂（cordis 每个 service name 只允许一个插件 `provide`，本插件 `inject` 等其它插件先提供该表后追加并广播 `internal/service` 触发重扫，与加载顺序无关）。只实现差异化能力（登录 / chat / token 刷新），连接池、模型管理、别名、凭证等通用能力由 dsh-router 核心统一管。

## 构建

```bash
pnpm install
pnpm build        # lib/index.js
pnpm typecheck
```

## License

MIT