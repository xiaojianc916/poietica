# agent client

本文描述桌面端当前真实实现。协议事实以 `packages/agent-bridge/src/protocol.ts`
与 `crates/agent-client/src/wire.rs` 为准 —— 那两份逐字对应，改一处必须同一次改完。

## 边界

- 唯一接的 agent 是 oh-my-pi（omp）。它**随包发**：`packages/agent-bridge` 把 omp 的
  SDK 编进一个可执行文件，用户不装 omp、不装 Bun、不装 node_modules（ADR 0052）。
- 传输是那一个子进程的 stdin/stdout，一行一条 JSON。
- Rust `agent-client` 拥有进程、连接、取消与事件生命周期。
- TypeScript 不直接访问 agent，只消费持久化后的帧与 transcript。

## 启动

1. 原生侧按 `agentId` 读受管档案，在应用可执行文件旁边解析边车
   （`process-host` 的 `resolve_sidecar`），解析不到才回落到 PATH。
2. 起边车，为它设受控 `PI_CODING_AGENT_DIR`（omp 的 agent 目录，绝对路径）。
3. 等它报 `ready`；版本对不上就拒这条连接，不猜字段。
4. `ready` 之后立刻开第一条会话，会话号回来才把 `Handshake` 交给界面。

每一条连接的 `cwd` 就是那条会话的工作区；多会话并发因此是**多条连接**，不是一条
连接上的多条会话。这是本层尚未接上的部分之一（见「缺口」）。

## 线上的两类帧

上行（Rust → 边车）：`new_session`、`load_session`、`prompt`、`cancel`、`steer`、
`answer_permission`、`answer_dialog`、`selectors`、`select`、`goal`、`transcript`、
`transcript_ops`、`browser_settings`、`set_browser_settings`、`settings_catalog`、
`set_setting`、`skills`、`mcp_servers`、`capabilities`、`model_catalog`、`shutdown`。
每条带 `id`，应答原样回。**正本是 `protocol.ts` 的 `BridgeCommand`**，这里不重抄清单
（§0）；`crates/agent-client/src/wire.rs` 的 `Command` 与它逐字对应。

下行（边车 → Rust）：`ready`、`response`、`failed`，以及这几类事件 ——

- `transcript`：屏幕经过。载荷就是 `packages/transcript` 钉住的 ops / reset 形状，
  本层**原样转交**，不解析（`SessionEvent::Transcript`）。
- `turn_end`：这一轮按 agent 自己的说法结束了（completed / cancelled / failed）。
  本机账本靠它收账，不去读 transcript 里的 turn 状态 —— 那会是第二个判别点。
- `selectors` / `usage`：可调项与用量。
- `dialog_requested`：agent 要问一个对话框。授权那一类（`method=select` 且选项集正是
  `Approve`/`Deny`）由本层翻成产品的一问一答，其余原样交给宿主。
- `questions_asked`：ask 工具的题组，**产品形状**（号由桥签发）。本层的提问桌收下它，
  人的答复经 `answer_dialog` 回去（ADR 0054）。

## 本地事件管线

    bridge frame -> session/bridge -> RunSlot -> Recorder -> run_events
                 -> Tauri event -> transcript store -> 投影 -> React

`run_events` 是一次运行的唯一事实来源：先落日志，再进渲染投影。React 状态不得
成为第二份运行历史。

## 谁说了算

- 屏幕经过 = agent 的 transcript（边车投影出来的那一份）。
- 模型上下文 = agent 自己。
- 对话索引 = threads 表（单写者）。
- 一轮的起止 = 本机 recorder（准入帧 + 终帧），agent 的 `turn_end` 是它的输入。
- 取消：命令发出去，同时上 `CANCEL_GRACE` 的闹钟；到期 agent 还没报终帧就由本机
  收摊，界面上不会永远停在「正在取消」。
- 在等人答的那几件 = 桥投影出来的 `interaction.upsert`（审批与提问），号与答复同号。
- agent 自己的设置 = agent 自己那份 `settings-schema`（我们读元数据画界面，写走它的
  持久层，ADR 0054）。

## 缺口（禁止当成能力用）

这些都**如实报「还没接」**，不假装成功，也不删界面控件（ADR 0052 后果第 5 条）：

- 会话分叉、删除、导出、列举（`client.rs` 的 `unwired()` 逐条列全）；
- 会话媒体字节；
- 能力清单的安装（omp 里没有对应物，读得到、装不了）；
- 计划正文的内联渲染（transcript 的 plan 帧留了位置，还没有生产者）。
