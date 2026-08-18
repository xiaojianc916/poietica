# 0022. 两条 agent 传输，一份帧契约

> Status: superseded by ADR 0024.

Status: accepted
Supersedes: 0008, 0021

## 裁决

Kimi 走 ACP 并保持默认；DeepSeek 走 deepseek-harness 官方 SDK 线协议
（`@deepseek-ai/dsh-sdk-jsonrpc-server` 的 newline-delimited JSON-RPC）。
两者不互相翻译：没有适配层，没有兼容层。

唯一共享的是 `crates/agent-runtime/src/frame.rs` 的 `RunFrame`。ACP 原文进
`acp_update`，harness 会话日志进 `harness_event`，两者都是协议原文槽；序号、
攒批、路由与 reducer 之后的一切对两家完全相同。

能力差异由握手报告表达，界面据此置灰并给出原因，不删控件。

## 后果

- `transport` 成为 agent 档案的一格，通用层不再按 agent id 分支。
- 时间线词汇归产品所有，协议类型只出现在成帧侧与投影侧。
- harness 无 cancel、无 session load/fork/delete、无 server 到 client 请求：
  停止走受控关停，其余在界面上标注为该 agent 尚未提供。
