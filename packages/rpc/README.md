# @poietica/rpc

JSON-RPC 2.0 传输层：连接 UI ↔ Host 的 IPC 与 Host ↔ Core 的 stdio，负责分帧、请求生命周期与错误折返。

## 职责

Core → Host 的帧以 `\x1e` 开头、`\n` 结尾，信封与载荷间用 `\x1f` 分隔；Host 只解析信封做路由，载荷留作 `RawJson`，以 JSON 文本转交页面解析。Host → Core 每行一条完整消息；Host → UI 经 `poietica:rpc` 桥收发。

`RpcPeer` 管理请求号、超时、取消与关闭，`Router` 按契约校验参数，`createTypedClient` 可校验结果。

## 关键导出

- `encodeFrame` / `encodeLine` / `decodeMessage`、`FrameDecoder`、`RawJson` / `jsonValue`、`relayParts` / `joinRelayParts`。
- `RpcPeer`、`Router`、`createTypedClient`、`Transport`、`RpcMeta`。
- `windowBridgeFromPreload`、`IPC_CHANNEL`、`BRIDGE_GLOBAL`：页面桥。
- `./stdio`：`createStdioTransport` 与 `createChildProcessTransport`。
- `./testing`：`transportPair`，真实编解码的内存传输。

## 边界

本包不定义业务契约与错误码；Host 消费 Core 载荷须经 `jsonValue()`。

详见 [§5 契约与协议](../../docs/ARCHITECTURE.md#5-契约与协议)。
