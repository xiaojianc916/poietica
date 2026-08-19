# kap capabilities

能力按真实传输通道划分，不按命令名或 UI 控件反推。

## REST

| 能力 | 官方表面 | 当前桌面端 |
| --- | --- | --- |
| 会话生命周期 | create / get / list / load / fork / archive | 主要路径已接入 |
| 提交输入 | submit / list | 已接入提交 |
| 排队 | queued / blocked 状态 | 未接入 |
| steer | prompt 与 session 两个入口 | 未接入 |
| abort | 结果带 `aborted` 与 `at_seq` | 已能取消，结果未完整建模 |
| profile 与 models | status / profile / models | 已投影成选择器 |
| approvals | pending / respond | 已接入 |
| questions | pending / respond / dismiss | 未接入 |

## WebSocket

| 控制 | 当前状态 |
| --- | --- |
| `client_hello` | 已接入 |
| `subscribe` 与 ack | 部分接入；三条会话路径未统一等 ack |
| `ping` / `pong` | 已接入 |
| abort | 基本路径已接入 |
| cursor `{ seq, epoch }` | 未持久化 |
| `resync_required` | 未处理 |

## 事件投影

kap 事件先记成 `RunFrame`，再由 TypeScript 投影成时间线。本地帧只有六种：

- `run_started`
- `kap_event`
- `permission_requested`
- `permission_resolved`
- `run_finished`
- `run_failed`

所以 Questions 不能继续冒充 permission：接入时必须新增独立领域事件、状态所有者
与回包类型，并一次删掉权限选项方言。

## 契约纪律

- `contracts/kap` 是协议漂移基线，不是已生成的客户端。
- Rust 侧仍显式解析 JSON，文档不得声称类型由快照生成。
- 接新能力的顺序是：先更新快照，再实现边界解析、生命周期与失败传播。
