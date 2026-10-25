# @poietica/feature-usage

按天的 token 与消息用量：Core 落账，设置页画概览、热力图与趋势图。

## 职责

- Core 订阅 `usageSampled`，每次模型调用写 `usage_events`，同事务累加 `usage_daily`；`userMessageSubmitted` 写入 `usage_messages`。
- `usage.tokenDays` 合计 input + output + cacheRead + cacheWrite；`usage.modelDays` 合计 input + output，按 `provider/model` 分组；`usage.messageCount` 数用户消息（含插话）。
- 「用量」页在 `agent` 组（order 700）；概览与趋势图可切 7 / 30 天，热力图固定 26 周；`/usage` 直达。
- 模型名读 `models.catalog`，缺失则用 `provider/model`。

## 子入口

| 入口       | 内容                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `contract` | `usage.tokenDays`、`usage.modelDays`、`usage.messageCount`；`from <= to` 且小于 400 天；无通知 |
| `core`     | 迁移与三张表、订阅 conversation 事件、三个按天查询                                             |
| `ui`       | 设置页、概览指标、Token 热力图、模型趋势图与模型名对照                                         |

## 对外接口

三个方法归 Core，按 `(from, to)` 读取。本包无 `ui-api`，也无 `usage.*` 通知；数据在挂载与切换窗口时读取。

## 边界

- 日期为本机时区 `YYYY-MM-DD`；`usage_events` 保留原始采样，线程删除不级联。
- `usage_daily` 以 `(day, provider, model)` 预聚合；Token 概览与图表只读这张表。
- 未读到的 Token 用量与消息数量显示 `—`，不以 0 代替。

见 [§7 数据与存储](../../docs/ARCHITECTURE.md#7-数据与存储)。
