# @poietica/workbuddy-client

WorkBuddy（腾讯 CodeBuddy 桌面端）的账号通道与本地反代适配层（L2，Bun）。

## 结构

| 路径                      | 内容                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugin/workbuddy.ts` | WorkBuddy 协议本身：鉴权、令牌续期、请求头与请求体改写、模型目录、积分、签到。纯函数 + 一个 `WorkBuddyAuthPlugin` 工厂，不认识 Poietica。 |
| `src/plugin/types.ts`     | 协议用到的形状（`Auth`、`Chat`、`Usage`、`JsonSchema` 等）。                                                                              |
| `src/session.ts`          | 把一个账号包成 `WorkBuddySession`：`fetch` / `usage` / `checkin` / `validate`。                                                           |
| `src/proxy.ts`            | 本机反代：只监听 `127.0.0.1`，只转发带随机口令路径的 chat 请求。                                                                          |

## 对外能力

- `startBrowserSignIn()`：返回上游授权页 URL 与等待回调；不碰 Poietica 的存储。
- `createSession(credentials, hooks)`：一个账号的 `fetch` / `usage` / `checkin` / `validate`；
  token 刷新经 `hooks.onUpdate` 交回宿主。
- `listModels()`：静态模型目录。
- `startWorkBuddyProxy()`：只监听 `127.0.0.1`，只把带随机口令路径的
  `/v1/chat/completions` 转发到 WorkBuddy；不接收任意上游 URL。账号失败经
  `onAccountFailure` 交回宿主并带上失败种类（登录过期 / 受限 / 额度用尽 / 限流），
  由宿主决定休息多久、要不要标成需要重新登录。

## 协议这一层是怎么来的

WorkBuddy 没有公开的 API 文档，这一层的每个常量、请求头、请求体改写都是从客户端实际行为与
大量实测里定下来的：`User-Agent` 不是 `WorkBuddy/<version>` 会被拒（错误码 10085）；
系统提示词会被「未授权渠道」检查拦下（11128）；思考块签名绑会话（11159）；账号异常会回 11140；
额度用尽回 14018。每条规则旁边的注释写的是**为什么**这样写、以及观察到它时的具体现象，
改之前先读那一段。

## 边界

本包不认识 RPC、数据库、React 或 Electron。账号、积分缓存、首选账号、
签到日程都在 `@poietica/feature-workbuddy` 的 Core 里。
