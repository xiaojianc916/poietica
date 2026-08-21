# kap client

本文描述桌面端当前真实实现。协议事实以 `contracts/kap/openapi.json`、
`contracts/kap/asyncapi.json` 和对应版本的 Kimi Code `kap-server` 源码为准。

## 边界

- 唯一 agent transport 是 kap 的 REST 与 WebSocket。
- Kimi Code 由 `kimi web --no-open` 启动。
- Rust `agent-runtime` 拥有进程、网络连接、取消与事件生命周期。
- TypeScript 不直接访问 kap，只消费持久化后的 `RunFrame`。

## 启动与发现

1. 原生侧按 `agentId` 读受管档案，并在搜索路径上解析本机可执行文件。
2. 启动 `kimi web --no-open`，为 Kimi Code 设受控 `KIMI_CODE_HOME`。
3. 从 Kimi Code 的实例注册目录读出这一次进程的 origin。
4. 从 `server.token` 读 bearer token，并用 `/api/v1/meta` 验证实例。
5. REST 与 `/api/v1/ws` 用同一 origin 与同一 token。

不使用关闭鉴权的启动参数，也不从 Web UI 反推服务地址。

## REST

成功响应是 `{ code, msg, data, request_id }` 信封。业务错误与传输错误分别保留，
不在边界上压成一条字符串。

当前用到的资源面：

- sessions：创建、读取、加载、分叉、归档；
- prompts：提交一次用户输入；
- profile / models / status：会话选择器与当前状态；
- approvals：拉取待处理审批并提交 decision；
- skills：读这条会话可用的技能目录，并激活其中一条。

## WebSocket

连接顺序：

    server_hello -> client_hello -> ack -> subscribe -> ack -> events

事件信封带 `type`、`seq`、可选 `epoch`、`session_id`、`timestamp` 与 `payload`。
服务端 `ping` 必须由客户端回 `pong`。

订阅带上本机存下的 `{ seq, epoch }`（persistence 的 `session_cursors`，轮终写一
次），`resync_required` 到达即判死那一轮并作废读点。

仍是缺口的：只有锚会话等 subscribe ack，open / load / fork 三条路径的 ack 只在
`not_found` 时留一行日志；从不发 `unsubscribe`；不校验
`server_hello.protocol_version`。

## 本地事件管线

    kap event -> driver -> RunSlot -> Recorder -> run_events
              -> Tauri event -> transcript store -> kap projection -> React

`run_events` 是一次运行的唯一事实来源：网络事件先落日志，再进渲染投影。
React 状态不得成为第二份运行历史。

## 交互

Approvals 走独立 REST 资源，客户端只在产品边界合成三个按钮：单次批准、本会话
批准、拒绝。

官方 Questions 是另一套独立资源：一次 1–4 题、单选或多选、可自由输入、可跳过。
它有自己的帧（questions_asked / questions_resolved）、自己的桌子（QuestionDesk），
回答与撤下分走 `POST …/questions/{id}` 与 `:dismiss`。

prompt queue 与 steer 同样未完成。

计划是会话开关（status 的 `plan_mode`，写回走 profile）。目标与蜂群没有开关：它们
是 agent 侧的循环，客户端能拿到的是 `goal_start` 与 `agent_call` / `task` 三档工具
显示，输入框上沿那排胶囊就是它们的投影。
