# 0025 — kap 是唯一的 agent 传输

## 状态

已接受。取代 0008、0009、0016、0024 中关于传输选型的部分。

## 决定

poietica 通过 `kimi web --no-open` 拉起 kap 服务，用 REST 发命令、用单条
WebSocket `/api/v1/ws` 收事件。不再存在 ACP 传输。

## 理由

- kap 提供机器可读契约：`GET /openapi.json`、`GET /asyncapi.json`（AsyncAPI 3.1.0，
  由 zod 经 `z.toJSONSchema` 生成）。Rust 侧类型必须从这两份文档生成。
- `prompt_id` 由客户端指定并在 `turn.started` 上回显，轮次归属可精确绑定。
- `:abort` 返回 `at_seq`，取消与本仓的 seq 线对齐。
- `:steer` 与提示词队列在 ACP 上没有对应能力。

## 约束

- 只使用 `/api/v1`。v2 路由同时注册，属上游迁移中状态，不接。
- 绑定 loopback。禁止 `--dangerous-bypass-auth`。
- 端口不可假定：`listenWithPortRetry` 在占用时按 port+1 递增，实际端口以
  `<KIMI_CODE_HOME>/server/instances/<ulid>.json` 中 pid 匹配到的条目为准。
- 凭据取自 `<KIMI_CODE_HOME>/server.token`。
- 实例注册表与令牌文件不在 OpenAPI/AsyncAPI 覆盖范围内，属文件约定，
  必须收敛在单一模块内并由启动探针校验。
