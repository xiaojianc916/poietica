# 0021 — omp 桥是一个库，不是一个 Webview 模块

## 状态

已接受，**已落地**（含"换 Bun 运行时替代自有编译产物"，见后果 §4）。
细化 0052（omp 是唯一的 agent）不动它的"用户不装任何 CLI，只装 Poietica"一条，
但**取代**它"SDK 编进我们自己的二进制"那句 —— 见下面第 7 条第 4 款；同时更正 0052
里"Rust 以 `--mode rpc` 驱动"一句 —— 实现从一开始走的就是我们自己的
`protocol.ts` ↔ `wire.rs`，不是 omp 的 rpc 模式。

## 背景

用户要求把 omp 的集成方式"从边车改成直接集成"。一种早期表述把"直接集成"写成
"让 `packages/agent-bridge` 成为**前端直调**的一个普通包"，并据此要求
`apps/desktop/src/entry/compose-agent.ts` 直接 `createBridge(host)`。

那条表述与实测事实矛盾。逐条复验（锚定 omp 18.3.0，源码树
`packages/agent-bridge/node_modules/@oh-my-pi/pi-coding-agent`）：

| 事实 | 实测 |
|---|---|
| `engines` | `{"bun": ">=1.3.14"}` —— **只认 bun**，没有 node |
| `browser` 字段 / Web 构建产物 | 没有；117 个 `exports` 键全指向 `src/*.ts` |
| `node:fs` import | 109 个文件（含 `node:fs/promises` 224 个） |
| Bun API | 323 个文件 |
| 持久层 | `bun:sqlite`（12 个文件） |
| `agent-session.ts` 顶层 | `:16 import * as fs from "node:fs"`；`:88` 引 `@oh-my-pi/pi-natives` |
| `pi-natives` | NAPI-RS `.node`，`createRequire` + `node:child_process` 加载 |

Webview2/WebKit 没有 Node API、不能 `dlopen .node`、没有 `createRequire`。
所以"前端直调 `createBridge()`"不是集成，是为整个 SDK 重写运行时。

## 决定

1. **`packages/agent-bridge` 是一个库，不是一个 Webview 模块。** `src/bridge.ts`
   导出 `createBridge(host)`，交出 `dispatch` / `subscribe` / `agentVersion`。
   它照常 `import "node:fs"`、`Bun.spawn`、`pi-natives`。**禁止**为了让它们进
   Webview 而改写这些调用。

2. **进程边界与一条 stdio 传输保留。** Webview 与 Bun 是两个 JS 引擎，没有共享堆；
   bridge 进不了 Webview（上表），所以两者之间必然有通道。删掉传输不会让边界消失，
   只会让边界没人守。`src/main.ts` 是那条通道的适配器：一行一条 JSON 的编解码与
   命令应答配对，**命令怎么执行它一行都不写**。

3. **`createBridge` 的调用面只有四个成员**（`dispatch` / `subscribe` /
   `agentVersion`）。不铺 `newSession()` / `prompt()` / … 那一层同名转发方法：
   它们会把命令清单抄成第二份（AGENTS.md §5「单一分发点」），而 `dispatch` 收的
   `BridgeCommand` 就是那份清单本身。

4. **受控 home 对不上就报错。** SDK 的 agent 目录是**模块加载时**解析的
   （`pi-utils/src/dirs.ts:446-449` 读 `PI_CODING_AGENT_DIR`），所以 `createBridge`
   只跟调用方对账，不去改它；对不上当场抛，绝不静默写到用户自己的 `~/.omp`。

5. **`agent-client` 的落账逻辑留在 crate 里。** 幂等、准入、投递不需要
   `AppHandle`/`State`/`Emitter`，按 AGENTS.md §3「凡是不需要 AppHandle/State/Emitter
   就能写出的逻辑，必须住在 crate 里并有自己的单测」，它属于 crate。曾有过把它搬进
   `apps/desktop/native/src/conversation/` 的提案，不采纳。

6. **`pi-natives` 的 `.node` 随包发到运行时同目录。** 编出来的 exe 拿不到包内的
   `.node`（`embeddedAddon` 为 null + 加载器对编译态关闭 `node_modules` 那条路），
   只靠用户目录里的缓存碰运气。随包发是唯一不依赖用户态的落点。
7. **摘掉 `PI_COMPILED`。** 它读的是**运行时环境**（`pi-utils/src/env.ts:466-470`），
   所以"构建期不折"不够。它一为真，pi-natives 的候选表会多出 `~/.omp/natives/<版本>/`
   与 `%LOCALAPPDATA%\omp` 并**排在最前**（`loader-state.js:156-185`），
   别人机器上残留的一份会盖过我们随包发的那个；SDK 的 CLI 入口块也会在进程里跑起来
   （第二个入口抢同一根 stdout）。官方 npm 发行版同样不设它（只折 `PI_BUNDLED`）。

## 为什么不切官方 RPC / ACP

omp 官方确有 stdio 的 RPC / ACP 模式（`--mode rpc|acp|rpc-ui`，以及 `omp acp`）。
不切过去：官方 RPC 的命令面里**没有** `settings_catalog`、`model_catalog`、
`mcp_servers`、`skills`、`delete_session`、`browser_settings` —— 我们一半的命令它
不存在。追过去的结果是"官方协议 + 自定义扩展"两套并存，比现在单一的自定义协议更差。

"按官方"落实在 **SDK 用法**上（`createAgentSession()` + `session.subscribe()` +
`Settings` / `ModelRegistry` / `SessionManager` 的既有写法），**不落实在传输协议上**。
线上形状仍是 `packages/agent-bridge/src/protocol.ts` ↔ `crates/agent-client/src/wire.rs`
这一对。

## 后果

1. `main.ts` 从 1965 行的边车入口降为 87 行的 stdio 适配器；1900 行主体搬进
   `bridge.ts` 的 `createBridge(host)` 闭包，**纯行段搬运**，不做手抄重打。
2. `src/index.ts` 的公开面**不含** `bridge.ts` / `main.ts`：它们拖得动整个 SDK，
   摆进出口清单会让只想用投影的调用方跟着吃下 SDK。
3. 线上形状、事件形状、`BRIDGE_PROTOCOL_VERSION` 逐字不变 —— 这一轮动的是产地
   怎么写，不是形状。
4. **"换 Bun 运行时替代自有编译产物"已按形态 B 落地。**
   旧形态是 187.7 MB 的 exe + 174.6 MB 的 `.node`（362.3 MB）；形态 B 是随包的
   `bun.exe` 82 + bundle 36 + `.node` 175（≈293 MB，小约 19%），去掉自有
   `compile` 管线与 187 MB 单文件产物。`tools/agent/build-bridge.ts` 换成
   `tools/agent/prepare-runtime.ts`；`externalBin` 换成 `bundle.resources`；
   档案的 `command` 从 `poietica-agent` 换成 `bun` + `entry: 'poietica-bridge.js'`。
   **一次换干净**：旧路径同一次改动删掉，不留开关双活。

5. **修掉了旧形态的一个出货缺陷：编出来的 exe 在干净机器上起不来。**
   `pi-natives` 的 `.node` 从来没被真正随包发过 —— 包内 `embedded-addon.js` 的载荷是
   `null`（编译期嵌入这条路的载荷是空的），而加载器 `shouldStageNodeModulesAddon`
   对 `isCompiledBinary` 直接返回 false（编出来的二进制不从 `node_modules` 取）。
   它当时能跑，只因为开发机上 `~/.omp/natives/<版本>/` 那份缓存是**跑源码版桥**时
   stag 进去的。证据：移开该缓存、把 `USERPROFILE`/`LOCALAPPDATA` 指向空目录，
   直接跑 exe → `Failed to load pi_natives native addon for win32-x64`；
   把 `-baseline.node` 放到 exe 旁边即 `ready`。
   形态 B 的落点是 `path.dirname(process.execPath)` —— 加载器候选表里**唯一在所有
   模式下都存在**的一格，也就是随包发的运行时自己那个目录。

6. `agent-client` 摘掉全仓零引用的死码：`DecodeError`、`EnvelopeError`、
   `RunFrame::kind()` 及其专用常量、`AgentClient::sessions()` 整条链（含
   `Command::Sessions` 与 `lifecycle::entries_of`）、`AgentClient::shutdown()` 及
   `Command::Shutdown` 与驱动器那一支。`PROMPT_ADMITTED` 留着 —— 它有真读者。

## 一个已知的、**本轮未引入**的缺口

`workerHostEntry()` 在新旧两种形态下都是 null。SDK 的 worker 子进程靠
`[executable, "__omp_worker_*"]` 重入它自己的 CLI 入口（`src/cli.ts:519` 的
`declareWorkerHostEntry()`），而我们的入口是 `main.ts`，不派发那些选择器。
**实测旧形态同一条路也一样失败**：把选择器当参数喂给旧 exe，它照常报 `ready`
然后等 stdin。所以这不是换运行时造成的退化。
后果是 `tools/browser/registry.ts` 里 `isCompiledBinary() || workerHostEntry() !== null`
那两个闸门与官方 npm 版不同（headless 走进程内自启而不是共享 broker、relay 不自动拉起）。
补齐的唯一出路是让桥也声明 worker host，但适配器不派发选择器，只会更糟 —— 本轮不动。

## 形态对比证据（2026-09 实测，锚定 omp 18.3.0，win32-x64）

| 形态 | 组成 | 合计 |
|---|---|---|
| 旧（修好原生模块之后） | exe 187.7 + `.node` 174.6 | ≈ 362 MB |
| A 发源码 | `bun.exe` 82 + 源码 + `node_modules` 闭包 673 | ≈ 755 MB |
| B 发 bundle（选定） | `bun.exe` 82 + bundle 36 + `.node` 175 | ≈ 293 MB |

耗时：`Bun.build({compile})` 4.0 s；`Bun.build({target:'bun'})` 36.0 MB / 0.6 s。
`--omit=optional` 把闭包从 879.4 → 673.5 MB（`onnxruntime-node` 287 MB + `onnxruntime-web`
135 MB 由 `@oh-my-pi/pi-mnemopi` 拖入，而 mnemopi 在 SDK 里是按需动态 import；bun 没有
"按需依赖"档位）。形态 A 因体积被否决。

## 待验证

- 一次真实模型轮次的端到端（本次只验到 `ready` / `capabilities` 等命令，未跑真实模型调用）。
- 多会话并发下的浏览器 headless 行为（见上一条缺口）。
- 换运行时若采纳，macOS/Linux 上的同款行为。
