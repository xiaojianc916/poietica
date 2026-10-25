# @poietica/feature-models

模型与模型服务商：维护凭据、自定义服务商、可用模型、默认模型与按用途的模型角色。数据来自引擎端口，本功能不保存模型目录的副本。

## 职责

- `models.providers` 列出服务商及是否已配置；API Key 只写不读，`clearApiKey` 与 `logout` 各清各的凭据。
- 账号登录交给 omp 的 OAuth 流程：`startLogin` 返回 `loginId`，授权网址、进度、待填项与结局经 `models.loginEvent` 推送，界面用 `answerLogin` 按 `promptId` 交回，`cancelLogin` 取消。
- 自定义服务商经 `models.upsertCustomProvider` / `models.removeCustomProvider` 增删改；内置服务商不可修改或删除。
- 模型目录、启用状态、默认模型与默认思考强度分别由 `models.catalog`、`models.setEnabled`、`models.defaults`、`models.setDefaults` 读写。
- `models.roles` / `models.setRole` 读取与设置 omp 的模型角色；`selector` 为 `null` 时撤销指定，交回 omp 的回退链。

## 子入口

| 入口       | 内容                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `contract` | 16 个方法、`models.loginEvent` / `models.changed` 通知；登录事件与自定义服务商的 zod 实体 |
| `core`     | 引擎调用的薄封装、登录流程与通知翻译、内置服务商保护                                      |
| `ui`       | 「模型」设置页（服务商目录、模型列表、认证区）、通用页的模型角色组、未配置提示            |

## 对外接口

方法覆盖服务商、凭据、账号登录、自定义服务商、目录、默认值与角色，全部 `owner: core`。登录以 `loginId` 串起事件流，`done` / `failed` 为终态。

## 边界

本功能只维护 omp 认识的配置；模型目录、角色清单与回退链均由引擎给出。API Key 从不读回，登录凭据由 omp 保存。
