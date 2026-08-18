# Architecture Overview

分层与依赖方向的唯一事实来源是 `tools/architecture/rules.config.mjs`，
由 `pnpm test:architecture` 在每次 CI 与提交前执行。本文只做解释，
与配置不一致时以配置为准。

## TypeScript 包分层

分层表、依赖方向、原生宿主白名单与目录命名的**唯一事实来源**是
`tools/architecture/rules.config.mjs`，由 `pnpm test:architecture` 执行。

这里不再重抄一份 —— 此前 README.md、AGENTS.md、本文件与
tools/architecture/README.md 各存一份手抄表，四份互相矛盾（本文件曾把磁盘上
不存在的 `test-kit` 列进 foundations，又漏掉一个真实存在的包），而唯一被
执行的是那份配置。手抄表只会制造第二个真相。

依赖只能指向更低层，同层互指必须在配置里逐条豁免。允许直连 `@tauri-apps/*` 的只有 `ipc`、
`desktop-adapters` 与 `apps/desktop`。

## 包边界的由来

`agent-contract` 曾经叫 `acp`。用协议名当包名，是把「这个包是什么」答成了「它今天
用什么协议说话」—— 而它八个文件里只有 `protocol.ts` 真的在讲 ACP，其余七个是本仓库
自己的会话、线程、能力与运行契约。它不并进任何一侧：名单与会话两边都要依赖它，并
进哪边都会让工作区依赖图成环，而 `workspace-graph-is-acyclic` 会当场报出来。Zed 的
`agent-client-protocol`、codex-rs 的 `protocol`、VS Code 的 `vscode-jsonrpc` 是同一种
摆法：契约独立成包。

三份真实录像住在 `agent-contract/src/recordings/`，由 `./recordings` 子路径公开。它们
证明的是「协议实际发出了什么」，不止一个包要靠它们证明自己的投影忠实 —— 所以它们跟
协议走，不跟第一个读到它们的包走。把 wire 值收窄成 `RunEvent` 的那句 cast 曾在三个
测试文件里各抄一遍，现在是 `asRunEvents` 一处。手写样本不在其中：它是插图不是证据，
留在用得到它的包的 `__fixtures__/sample-run.ts` 里，而读它的替身已经从公共入口撤下 ——
一个测试替身挂在主入口上、还把夹具当缺省参数，是产品代码通往 78KB 录像的一条边。

`agent` 是 `agent-timeline` 与 `agent-session` 合并来的。这条边按历史切：
`timeline/` 把 kap 事件投影成可渲染的时间线，`session/` 在它上面管线程、转录与
可调项 —— 同一条管线的前后两段，前一段的类型就是后一段的输入。分成两个包唯一的
产物是分层表里的一条同层豁免，而那条豁免的理由逐字写着「同一条管线的两段」：
豁免本身就是「这道边界表达不了这条关系」的自白。工作区只有一个应用，它本来就同时
依赖两侧，所以这道包边界从未决定过任何产物的字节数，只决定过谁能 import 谁。

两侧的目录边界留在包内，而且比原来更硬：`timeline/` 至今一行 React 都没有。这件事
此前靠一份没写 react 的 manifest 守着，现在由 `timeline-projection-stays-pure` 守着 ——
后者连测试文件一起管，而 manifest 管不到 devDependencies 里已经装了 react 的包。Zed 的
`acp_thread` 与 codex-rs 的 `thread-store` 是同一种摆法：投影与状态同住一处，纯的那
一半靠目录隔开。

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

- 目录名必须等于 `@poietica/<目录名>`。
- 新增包必须先在分层表中定层，否则架构检查抛错。
- 跨包访问只走公开 exports，禁止 deep import 与跨包相对路径。
- 每一类状态只能有一个权威来源与一条写入路径。

## 这个目录里有什么

| 文档 | 内容 |
| --- | --- |
| [`acp-capabilities.md`](./acp-capabilities.md) | ACP 能力通道目录 |
| [`acp-client.md`](./acp-client.md) | The ACP client |
| [`agent-activity-feed.md`](./agent-activity-feed.md) | AI activity feed |
| [`agent-persistence.md`](./agent-persistence.md) | AI persistence |
| [`data-layout.md`](./data-layout.md) | 磁盘布局 |
| [`rust-layers.md`](./rust-layers.md) | Rust Crate 分层 |
| [`ui-authority-boundaries.md`](./ui-authority-boundaries.md) | UI authority boundaries |
| [`window-lifecycle.md`](./window-lifecycle.md) | Window Lifecycle |
