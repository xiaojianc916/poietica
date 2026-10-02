# 0033 — 接入档案收敛成一份文档：删掉「默认 agent」与 AgentLaunch

## 状态

已接受，已落地。

## 背景

ADR 0016 说 omp 是唯一的 agent，但 agents.json 一直是**接入档案的名单**
`{agents: [...], defaultAgentId}`：TS 侧 `resolveAgentProfile(stored[])` 按 id 挑一条、
滤掉别家的条目并报 `FOREIGN_ISSUE`，native 侧同名函数按 `default_agent_id` 挑一条，
渲染层每次调用都要把 `{agentId}` 连同请求一起交过来（`AgentLaunch`）。

于是「哪一家」这件事有四份说法：名单的挑法、默认那条、请求里的 agentId、以及各层
自己挑完再传下去的参数。名单里永远只有一条，四份说法永远一致 —— 一致是巧合，不是约束。

## 决定

档案就是那一份文档，全链路不再有 agent 身份：

- **落盘**：agents.json 里 `agentConfig` 那一格从 `{agents: [...], defaultAgentId}` 变成
  档案本身（`{id, command, entry, ...}`），不再包一层数组。native 的 `read_profile` 认旧形状
  就取第一条并顺手改写；那个读法与它的单测留在 `profile.rs`，注明等没人从 ≤0.4.3 升上来就删。
- **TS**：`resolveAgentProfile(stored: unknown)` 就地校验 + 投影；`FOREIGN_ISSUE` /
  `DUPLICATE_ISSUE` 随名单一起删。线上快照是 `{profile: JsonValue | null, issues}` ——
  `issues` 就是原有的「问题」那一列，没有改名。
- **native**：删 `AgentLaunch` 与 `default_agent_id()`；接档的函数
  （`agent_program`/`agent_entry`/`agent_args`/`launch_env`/`agent_data_home`/
  `controlled_mcp_config`）不再收 id，自己从档案里读。会话各条命令用新的
  `profile::agent_id()` 取唯一身份。
- **命令**：`agent_config_save_agents(agents, defaultAgentId)` → `agent_config_save(profile)`。
- **渲染层**：`AgentBridgeOptions.launch()`（它同时是「会话可以开了没有」的握手）改名
  `ready()`，不再返回 agentId；`AgentRuntimeDependencies.agentId` 删掉；模型目录端口与
  Thinking 偏好的键也不再带 agent 身份。
- **描述符**：`AgentDescriptor.displayName` 删掉 —— 它是「把家列出来给用户挑」的形状，
  界面上从来没有这个选择器。

改动前的正本：`git show HEAD:packages/agent-catalog/src/agent-profile.ts:163`
（`resolveAgentProfile(stored: readonly unknown[])`）、
`git show HEAD:apps/desktop/native/src/agent/profile.rs:122,145,263`
（`read_config` / `profile_of` / `default_agent_id`）。

## 验收

- `bun run typecheck`、`bun test`、`cargo clippy -- -D warnings`、`ipc:check` 全绿。
- 全仓不再有 `AgentLaunch`/`agentConfigSaveAgents`/`defaultAgentId`/`displayName`（agent
  描述符那一格）的引用。
- 旧盘 `agentConfig` 里的 `{agents: [...]}` 第一次读时抬升成档案，抬升后落盘的就是新形状。

## 影响

`agents.json` 里 `agentConfig` 那一格的形状变了。手改过那一份文件的用户：旧形状仍被读一次
并改写。档案里各键的名字与含义都没变。
