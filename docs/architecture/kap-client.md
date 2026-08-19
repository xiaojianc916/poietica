# kap client

本文描述桌面端当前真实实现。协议事实以 `contracts/kap/openapi.json`、
`contracts/kap/asyncapi.json` 和对应版本的 Kimi Code `kap-server` 源码为准。

## 边界

- 唯一 agent transport 是 kap 的 REST 与 WebSocket。
- Kimi Code 由 `kimi web --no-open` 启动。
- Rust `agent-runtime` 拥有进程、网络连接、取消和事件生命周期。
- TypeScript 不直接访问 kap；只消费持久化后的 `RunFrame`。

## 启动与发现

1. 原生侧按 `agentId` 读取受管档案并解析本机可执行文件。
2. 启动 `kimi web --no-open`，并为 Kimi Code 设置受控 `KIMI_CODE_HOME`。
3. 从 Kimi Code instance registry 读取该进程对应的 origin。
4. 从 `server.token` 读取 bearer token，并用 `/api/v1/meta` 验证实例。
5. REST 请求和 `/api/v1/ws` 使用同一 origin 与 token。

禁止使用关闭鉴权的启动参数，也不通过 Web UI 反推服务地址。

## REST

成功响应使用 `{ code, msg, data, request_id }` 信封。业务错误与 HTTP/传输错误
必须分别保留，不能在边界上压成一条字符串。

当前桌面端使用的主要资源包括：

- sessions：创建、读取、加载、分叉和归档；
- prompts：提交一次用户输入；
- profile/models/status：会话选择器与当前状态；
- approvals：读取待处理审批并提交 decision。

## WebSocket

连接顺序是：

    server_hello -> client_hello -> ack -> subscribe -> ack -> events

事件信封包含 `type`、`seq`、可选 `epoch`、`session_id`、`timestamp` 与
`payload`。服务端 `ping` 必须由客户端回复 `pong`。

当前实现能等待锚会话的 subscribe ack，但 open/load/fork 的订阅还没有统一
到同一所有权模型；也尚未持久化服务端 `{ seq, epoch }` cursor 或处理
`resync_required`。这些是明确缺口，不得写成已经支持。

## 本地事件管线

    kap event -> driver -> RunSlot -> Recorder -> run_events
              -> Tauri event -> transcript store -> kap projection -> React

`run_events` 是一次运行的唯一事实来源。网络事件先写入日志，再进入渲染投影；
React 状态不能成为第二份运行历史。

## 交互

Approvals 已接入独立 REST 资源，客户端只在产品边界合成三个按钮：单次批准、
本会话批准和拒绝。

官方 Questions 是独立资源，支持 1–4 题、单选/多选、自由输入和跳过。
当前仓库仍有一条把题目编码成权限选项的遗留 UI 路径，但 Rust driver 没有接入
官方 Questions。它是待删除的阻塞项，不是兼容策略。

Prompt queue、steer、cursor 恢复和 resync 同样尚未完成。
