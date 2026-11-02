# @poietica/workbuddy-client

WorkBuddy（腾讯 CodeBuddy 桌面端）的账号通道与本地反代适配层（L2，Bun）。

## 来源与许可

`src/vendor/workbuddy.mjs` 逐字来自[`magpie-community/plugins`](https://github.com/magpie-community/plugins) 的
`packages/workbuddy/index.mjs`（版本 0.2.13），**MIT**。原许可全文在
`src/vendor/LICENSE`；本包只把它包进 Poietica 的账号存储与本地 HTTP 端点，
不改插件内部的鉴权、请求头和请求体改写。

更新方式：整文件替换 `workbuddy.mjs`，按实际用到的字段核对
`workbuddy.d.mts`，然后跑本包的测试与 `bun run check`。

## 对外能力

- `startBrowserSignIn()`：返回上游授权页 URL 与等待回调；不碰 Poietica 的存储。
- `createSession(credentials, hooks)`：一个账号的 `fetch` / `usage` / `checkin` / `validate`；
  token 刷新经 `hooks.onUpdate` 交回宿主。
- `listModels()`：插件静态模型目录。
- `startWorkBuddyProxy()`：只监听 `127.0.0.1`，只把带随机口令路径的
  `/v1/chat/completions` 转发到 WorkBuddy；不接收任意上游 URL。账号失败经
  `onAccountFailure` 交回宿主并带上失败种类（登录过期 / 受限 / 额度用尽 / 限流）
  与插件写的 `X-Magpie-Sign-In` 语义，由宿主决定休息多久、要不要标成需要重新登录。

## 边界

本包不认识 RPC、数据库、React 或 Electron。账号、积分缓存、首选账号、
签到日程都在 `@poietica/feature-workbuddy` 的 Core 里。
