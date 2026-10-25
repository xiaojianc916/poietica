# @poietica/feature-automations

按 cron 或一次性时间，在指定工作区无人值守地发起对话，并记录结局与提醒。

## 职责

- `core` 用 SQLite 的 `automations_automations`、`automations_runs` 保存任务、下次运行时间与运行历史。
- `cron` 与 `at` 二选一，都带 IANA 时区；校验区分 `unreadable`、`never_runs`、`too_frequent`、`time_zone`、`in_past`、`conflict`。
- 调度器每 30 秒扫描到期任务；启动时修复中断的运行，按 `catchUp` 补跑或记 `skipped`，上一次未结束时跳过。
- 运行时经 `ConversationServiceToken` 新建或续用对话，带入工作区、`posture`、`model`、`thinking`；运行超时 60 分钟，等待批准超时 2 小时。线程或工作区删除时清理关联。
- `notice.ts` 判定通知：`never` 从不，`attention` 只在失败、等批准或 agent 标记关注时，`always` 另含成功；UI 只把结果转成系统通知。
- 向 agent 注册八个 `automation_*` 工具；运行中的对话不能管理任务。

## 子入口

| 入口       | 内容                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| `contract` | 任务、草稿、补丁、运行与提醒的 zod 实体；10 个方法与 3 条通知                            |
| `core`     | 迁移与仓库、计划计算、调度器、运行器、通知判定、RPC 与 agent 工具                        |
| `ui`       | `automations.list` / `automations.edit` 两个 surface、侧栏入口、从对话创建任务、工具卡片 |

## 对外接口

10 个方法覆盖任务增删改查、启停、立即运行、取消运行、运行历史与计划预览；通知为 `automations.changed`、`automations.runUpdated`、`automations.attention`。

## 边界

删除任务先取消正在进行的运行，但保留它创建过的对话；执行由 conversation 负责，本功能只触发、等待、取消与记录。
