# @poietica/feature-conversation

Agent 对话主干：线程、提交、时间线、运行控制与交互，统一接到 omp 会话。

## 职责

- **线程**：线程行在 `conversation_threads`，消息与轮次的事实只在 omp 会话文件中；`threads.*` 覆盖列表、创建、打开、重命名、置顶、归档、删除、分叉、导出与分享。删除线程时，库行与待回收会话文件在同一事务中落账，文件删除失败留待下次启动重试。
- **会话池**：会话按需打开；`threads.open` 在用户开始写这句话时预热，第一次提交也会打开；同线程并发打开只开一次。空闲超过 10 分钟或空闲会话超过 6 个时按最久未用驱逐，运行中或有待答交互的会话不驱逐；模型或引擎设置变化后换代。
- **提交**：`turns.submit` 只做查表级检查，先把提交存入 `conversation_submissions` 并推送，再在后台打开会话交给 omp，因此界面气泡是 Core 已存库的事实。状态为 `pending → started / queued / failed`；失败可 `retry`（号不变）或 `discard`。
- **时间线**：`timeline.subscribe` 返回快照、`epoch`、`seq` 与待显示提交，随后推送 `timeline.ops`；`timeline.page` 可冷读更早历史，不打开会话；`timeline.catchUp` 补发漏批，`timeline.reset` 要求整页重取。
- **运行协作**：控件（模型、思考、姿态、计划、目标）、队列（插话 / 排队）、待答交互、斜杠命令、侧边提问、子代理与后台任务各有契约方法；事件路由把引擎事件翻译为通知与 Core 事件。

## 子入口

| 入口       | 内容                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract` | 上述方法与通知；`Thread`、`SubmissionView`、`TimelineSnapshot`、`mediaAssetUrl`                                                                           |
| `core`     | 线程与提交服务、会话池、时间线 hub、事件路由、`show_image` 工具、迁移与回收                                                                               |
| `core-api` | `ConversationServiceToken`、`TurnContextRegistryToken` 与 `turnSettled`、`submissionFailed`、`threadRemoved`、`usageSampled`、`userMessageSubmitted` 事件 |
| `host`     | 注册 `poietica-asset://media/`，从 omp blob 目录流式读取图片；无 Host 契约方法                                                                            |
| `ui`       | 入口页与线程页、输入框、时间线渲染、右坞辅助对话与子代理、命令与快捷键                                                                                    |
| `ui-api`   | `ConversationUiToken` 与贡献点：工具卡、输入框处理器、草稿动作、线程动作、正文文件链接等                                                                  |

## 对外接口

`ConversationServiceToken` 供 Core 内其它功能建线程、提交一句、取消与读取线程；`TurnContextRegistryToken` 让提供方在每次交接时同步交出下一句的上下文，送达后回调 `delivered`，排队项被丢弃或撤回时回调 `undelivered`。`ConversationUiToken` 提供 `activeThreadId`、`activeComposer`、`composerOf`、`openThread`、`sendText` 等跨功能入口。

错误码包括 `conversation.thread_not_found`、`thread_busy`、`thread_empty`、`interaction_not_found`、`thread_start_failed`，以及提交结局 `submit_dropped`、`submit_cancelled`、`core_restarted`。

## 边界

对话内容以 omp 会话文件为唯一来源，本功能不认识具体模型实现；SQLite 保存线程行、提交行与回收队列，提交行承载即时回显与失败重试所需的请求数据。工作区删除由 `workspaceRemoved` 触发线程级联；附件引用以 `conversation:thread:<id>` 登记，分叉时复制。运行模型见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §4。
