# Architecture Overview

分层与依赖方向的唯一事实来源是 `tools/architecture/layering.ts`，
由 `bun run test:architecture` 在每次 CI 与提交前执行。本文只做解释，
与配置不一致时以配置为准。

## TypeScript 包分层

分层表、依赖方向、原生宿主白名单与目录命名的**唯一事实来源**是
`tools/architecture/layering.ts`（判据在 `policies.ts` 与 `charters.ts`），
由 `bun run test:architecture` 执行。

这里不再重抄一份 —— 此前 README.md、AGENTS.md、本文件与
tools/architecture/README.md 各存一份手抄表，四份互相矛盾（本文件曾把磁盘上
不存在的 `test-kit` 列进 foundations，又漏掉一个真实存在的包），而唯一被
执行的是那份配置。手抄表只会制造第二个真相。

依赖只能指向更低层，同环互指一律禁止。允许直连 `@tauri-apps/*` 的只有生成物
`@poietica/contract` 与 `@poietica/native-bridge`（判据是 layering.ts 的
HOST_AWARE_PACKAGES）。

## 包边界的由来

### Wire 与领域模型的边界

agent 会话的端口与线上词汇住在 `packages/conversation/src/agent/`：它表达的是
本产品的会话、线程、工具调用、审批和运行契约，只有类型、没有实现——实现的唯一
住所在 `@poietica/native-bridge`，由组合根注入。只有 `kap.ts` 保存 KAP wire
直接给出的最小词汇；产品自己投影出来的工具调用形状放在 `tool-call.ts`，审批
按钮放在 `permission.ts`。

因此只有 wire-issued 标识和事件保留 `Kap*` 前缀。本地的 `ToolKind`、
`ToolCallUpdate` 不冒充协议类型，也不提供旧名称别名。

`conversation` 内部的目录边界比包边界更硬：`timeline/` 把 kap 事件投影成可渲染
的时间线，`session/` 在它上面管线程、转录与可调项，`agent/` 只有类型 ——
同一条管线的前后两段，前一段的类型就是后一段的输入，目录就是它们之间的界。
`timeline/` 至今一行 React 都没有，这件事由 layering.ts 的
framework-free-vocabulary 守着（覆盖全部领域包，连测试文件一起管）。Zed 的
`acp_thread` 与 codex-rs 的 `thread-store` 是同一种摆法：投影与状态同住一处，
纯的那一半靠目录隔开。

`agent-catalog` 是 `agent-registry` 与 `agent-providers` 合并来的。那条边按历史切，
不按职责：两边都以 agentId 定址、都开了同名的每家子目录、注释互相引用对方的
分法。合并后包内按 agentId 分文件；agent 名单与 provider 解析同处一包，而解析
那一侧仍然不认识任何一家 —— 它只认调用方递进来的字面量，那道护栏由
`kimi/__tests__/descriptor.test.ts` 与 `__tests__/provider-state.test.ts` 两边对钉。
它此前叫 `agents`：复数名词声明的是「这里面有不止一个」，不是这个包负责什么，而同层
另一个包也在处理 agent。

这个包里没有 model catalog，也没有 provider profile —— 这是结论，不是遗漏。
`model-provider-profile` 描述的是「启动 agent 时把 base URL、密钥、默认模型注入环境
变量」：kimi-code 的 providers.md 写明它取凭据时不回落 shell 环境变量，那条路本来就
不通；那份实现还把 provider 方言枚举成两种、把模型 id 硬编码，而上游的
`ProviderTypeSchema` 是 `z.string()`，刻意不在解析期枚举 vendor 身份。
`model-catalog` 则自己去拉 models.dev，而 agent 内部拉的是同一份、写入又必须过它的
CLI 校验 —— 两份可能不同步的副本里只有一份说得上话。候选模型问 agent 的
provider catalog list。

## 强制约束

- 包名由 `@poietica` 前缀加目录名构成：路径就是身份，不许两套叫法。
- 新增包必须先在分层表中定层，否则架构检查抛错。
- 跨包访问只走公开 exports，禁止 deep import 与跨包相对路径。
- 每一类状态只能有一个权威来源与一条写入路径。

## 这个目录里有什么

| 文档 | 内容 |
| --- | --- |
| [`kap-client.md`](./kap-client.md) | kap 客户端、生命周期与已知缺口 |
| [`agent-activity-feed.md`](./agent-activity-feed.md) | AI activity feed |
| [`agent-persistence.md`](./agent-persistence.md) | AI persistence |
| [`data-layout.md`](./data-layout.md) | 磁盘布局 |
| [`rust-layers.md`](./rust-layers.md) | Rust Crate 分层 |
| [`ui-authority-boundaries.md`](./ui-authority-boundaries.md) | UI authority boundaries |
| [`window-lifecycle.md`](./window-lifecycle.md) | Window Lifecycle |
