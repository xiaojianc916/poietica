# 0032 — agent 运行时安装这条管线整条移除

## 状态

已接受，已落地。删 `crates/agent-client` 的 `process/install.rs` 与
`InstallSpec`/`install_spec_of`/`is_npm_package_name`、native 的 `agent/install.rs` 与
`agent_install_status`/`agent_install_run` 两条 IPC、`@poietica/settings` 的安装端口与
设置页那一格、接入档案里的 `install` 一格；生成绑定随 `bun run ipc:generate` 重生成。

## 背景

omp 随包发（ADR 0016、0021），它的档案从来没有 `install` 一格 ——
`packages/agent-catalog/src/omp/descriptor.ts` 只声明 program/entry/env/home。

于是这条管线在唯一在册的 agent 上**恒为空转**：

1. 原生 `compute()` 拿不到安装档案时返回 `Unmanaged`（原 `agent/install.rs:104`）；
2. 渲染层只对 `missing`/`outdated` 画按钮或说明，`Unmanaged` 经 `describeState` 得 null，
   整行渲染 null。

设置页「智能体」那一格是它唯一的挂载点，所以那一格对 omp 只有「名字 + 一句描述」。
产品裁决：软件只有 omp，不为「以后可能接一家要装的 agent」留预留。

## 决定

整条管线一次删干净（AGENTS.md §8），不留兼容层、不留开关双活：

- 能力层：`crates/agent-client/src/process/install.rs` 整文件；`InstallSpec`、
  `install_spec_of`、`is_npm_package_name`（后者只服务于这一格）。
- 命令层：`apps/desktop/native/src/agent/install.rs` 整文件、两条 IPC 命令与它们的类型注册。
- TS：`AgentSettings.loadInstallStatus`/`runInstall`、native-bridge 的两条端口、
  `AgentInstallAction` 组件、设置页「智能体」一栏。
- 接入档案：TS（`AgentProfile`/`ProfileSchema`）与 Rust 两侧的 `install` 一格。

顺带删掉 agentConfig 的「配置变了」通道（`notifyConfigChanged`/`subscribeConfigChanged`）：
它唯一的触发者就是安装完成。`conversation.capabilities.refresh` 不受影响 —— 插件账本自己的
订阅仍在触发它（`compose-runtime.ts`）。

**不动的两件**：`AgentCapabilityInstall` 是 omp 自己能力的开关（computer-use 等），
不是「装一个 agent」；agents.json 与 `resolveAgentProfile` 是接入档案的落盘与判读，
起会话那条路要用它。

## 验收

- `bun run check` 全绿：biome、架构闸门、全工作区 typecheck/test，rustfmt/clippy/cargo test，
  `ipc:check` 与生成器一致。
- 设置→模型页只剩「已配置的模型」与「供应商」两格。
- 全仓不再有 `installSpec`/`agentInstall`/`agent_install`/`AgentInstallAction` 的引用。

## 未做到 / 记录

agents.json 里「多家」的形状当时还在：别家条目的过滤与 `FOREIGN_ISSUE`、`defaultAgentId`、
`agentConfigSaveAgents`。那是接入档案这套机制本身，不是安装；把它收敛成 omp 常量
（ADR 0016 已说 omp 是唯一的 agent）是另一件事，本次不做。

**2026-10 补记（ADR 0033）：** 那一件事已经做了 —— `resolveAgentProfile` 现在收一份文档、
native 的 `AgentLaunch` 与「默认 agent」都删了。本 ADR 记的是当时的边界，上面的形状已不存在。
