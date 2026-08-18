# 0025. Kimi Code 只经 ACP 接入

Status: Superseded by 0025-kap-is-the-only-agent-transport.md

Status: accepted
Supersedes: 0016

## 背景

上游对外有两条线，只有一条是给外部客户端的公开面。

| 线 | 包 | 事实（MoonshotAI/kimi-code） |
| --- | --- | --- |
| `kimi acp` | `packages/acp-server` | 依赖 `@agentclientprotocol/sdk`，`start.ts` bootstrap `agent-core-v2`；官方 reference 页给出能力矩阵 |
| kap 线 | `packages/kap-server` + `packages/node-sdk` | 两者 `package.json` 均 `"private": true`；Fastify + ws 本地服务，客户端必须是 Node |

另一个仓库发布的 `@moonshot-ai/kimi-agent-sdk` 不是 Kimi Code 的 SDK：
`node/agent_sdk/paths.ts` 的家是 `~/.kimi`，而 Kimi Code 的家是 `~/.kimi-code`。

0016 把裁决锚在 `acp-v2` 子命令上，上游已退役该子命令。

## 裁决

`kimi acp`（agent-core-v2 引擎）是唯一集成面。不引 kap-server、不引任何
`private` 内部包、不起本地 HTTP 端口。协议类型只从官方 ACP SDK re-export。

理由与 0023 同源：跨进程线协议一旦是私有未发布契约，产品地基就挂在别人的
内部重构上；而 Tauri 宿主没有 Node 运行时可以让 SDK 作为库住进来。

## 已知缺口（登记，不另开第二条路）

- `terminal/create|output|release|kill|wait_for_exit` 未接，shell 走本地执行。
- unstable 面只有 `session/set_model`。
- `promptCapabilities.audio = false`。
- `session/close`：官方矩阵记未实现，上游测试文件另有说法，未取证。

缺口的处置只有一种：等上游把口开在 ACP 上。不用第二条协议补。

## 复核

带 `POIETICA_ACP_TRACE` 跑一次真握手，读 `initialize` 的
`agentCapabilities` / `sessionCapabilities`，以 payload 为准。
