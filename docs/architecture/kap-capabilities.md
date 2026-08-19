# kap capabilities

能力按真实传输通道划分，不再按命令名或 UI 控件反推协议能力。

## REST resources

| 能力 | 官方表面 | 当前桌面端 |
| --- | --- | --- |
| Session lifecycle | create/get/list/load/fork/archive | 已接入主要路径 |
| Prompt submission | submit/list | 已接入提交 |
| Prompt queue | queued/blocked 状态 | 未完整接入 |
| Prompt steering | prompt/session steer | 未接入 |
| Prompt abort | abort result 与 `at_seq` | 已取消，但未建模完整结果 |
| Profile and models | status/profile/models | 已接入选择器投影 |
| Approvals | pending/respond | 已接入 |
| Questions | pending/respond/dismiss | 未接入 |

## WebSocket controls

| 控制 | 当前状态 |
| --- | --- |
| `client_hello` | 已接入 |
| `subscribe` / ack | 部分接入；所有会话路径尚未统一等待 ack |
| `ping` / `pong` | 已接入 |
| abort | 已接入基本路径 |
| cursor `{ seq, epoch }` | 未持久化 |
| `resync_required` | 未处理 |

## Event projection

KAP 事件先被记录成 `RunFrame`，再由 TypeScript 投影为时间线。当前本地帧只有：

- `run_started`
- `kap_event`
- `permission_requested`
- `permission_resolved`
- `run_finished`
- `run_failed`

因此 Questions 不能继续冒充 permission；接入时必须新增独立领域事件、状态所有者
和回包类型，一次删除权限选项方言。

## 契约纪律

- `contracts/kap` 是协议漂移快照，不是已生成的 Rust 客户端。
- 当前 Rust 仍显式解析 JSON；文档不得声称类型已经由快照生成。
- 新增官方能力前，先更新快照，再实现边界解析、生命周期和失败传播。
