# @poietica/feature-workbuddy

WorkBuddy（腾讯 CodeBuddy 桌面端）账号、积分、每日签到与内置反代。

## 职责

- 账号：浏览器授权（多账号）、API Key；首选账号、重新登录、移除。
- 积分：读 WorkBuddy 的资源摘要，保留最近一次快照；API Key 账号不读积分。
- 签到：手动领取当前账号的每日积分；`每日自动签到` 打开时，每天每个 OAuth 账号只尝试一次。
- 反代：启用后在本机 `127.0.0.1` 起一个带随机口令路径的 OpenAI chat 端点，只转发到
  `copilot.tencent.com`，并注册 omp 的 `workbuddy` 自定义服务商。账号 401 时按首选顺序换下一个。

## 子入口

| 入口       | 内容                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| `contract` | 11 个方法、`workbuddy.changed` / `workbuddy.loginEvent`、账号与积分实体 |
| `core`     | SQLite 账号仓储、登录流程、积分/签到、反代生命周期、服务商注册          |
| `ui`       | 设置 → 反向代理：账号列表、积分条、签到、首选、反代开关与状态           |

## 数据

`%APPDATA%\Poietica` 下的 `workbuddy_accounts` / `workbuddy_settings` 两张表。
令牌以明文存本机（与 omp 自己的凭据同级）；日志不打印令牌、请求体或上游对话。

## 边界

- 反代逻辑与 WorkBuddy 协议在 `@poietica/workbuddy-client`（L2）里，本功能只做存储、
  RPC、Provider 注册与界面。
- 只依赖 `@poietica/engine` 的 `ModelsPort`，不 import `engine-omp`。
- 插件来源与 MIT 许可见 `packages/workbuddy-client/src/vendor/LICENSE`。
