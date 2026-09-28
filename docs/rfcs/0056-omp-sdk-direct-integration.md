# 0056 — omp SDK 直接集成（去边车化）

状态：草案（已拍板，待实施）。触发：用户明确要求"直接集成"，且产品只接 omp 一家 agent。两件事由本文拍板（见 §11），不再回问。

本文定义"直接集成"的准确含义：**去掉自有编译 exe 与 Rust 的 NDJSON 透传层，让 `packages/agent-bridge` 成为前端与其余 TS 包直调的一个普通包**，omp SDK 随它一起由随包分发的 Bun 运行时承载。

> **名词约定**：下文"前端直调"指**直调 bridge 的方法面**（`createBridge()` 返回的对象），不是指 bridge 代码跑在 Webview 里。bridge 与 SDK 跑在随包分发的 Bun 运行时里（§2），前端通过 Bun 的 `import` 机制在同一 JS 引擎里直接调用——中间没有 Rust、没有 NDJSON、没有 spawn。

---

## 0. 先厘清一个事实

当前仓库里**没有 omp 官方 CLI 边车**。`agent-catalog` 档案里 `command: 'poietica-agent'` 指向的是 `apps/desktop/src-tauri/binaries/poietica-agent-<triple>.exe`，它是 `packages/agent-bridge/src/main.ts` 经 `tools/agent/build-bridge.ts` 用 `Bun.build({compile})` 编出来的**自有单文件**，omp SDK 已经编在里面（ADR 0052）。

所以"边车 vs 直接集成"的真实差别只剩一层：**Rust 与 bridge 之间隔着多少东西**。今天是"Rust → spawn → NDJSON stdin/stdout → main.ts → SDK"；直接集成是"TS 调用方 → `createBridge()` → SDK"，中间没有 spawn、没有线上协议、没有编译产物。

### 0.1 决定可行性的实测证据（2026-09，锚定 omp 18.3.0）

在动手前先钉死两件事：SDK 的宿主耦合度，以及官方"进程内集成"到底嵌在什么宿主里。两条候选路线的生死都由它们决定。

**宿主耦合度（源码树 `Select-String` 全量统计）：**

| 探测点 | 结果 | 出处 |
|---|---|---|
| `node:fs` import（`pi-coding-agent` 全树） | **224 个文件** | `pi-coding-agent/src` |
| Bun API（`Bun.*` / `bun:`，全树） | **330 个文件** | 同上 |
| spawn 子进程 | **42 处**（LSP、eval/py、dap、插件管理器等） | 同上 `Bun.spawn` 等 |
| `agent-session.ts` 顶层 | `import * as fs from "node:fs"` + `import … from "@oh-my-pi/pi-natives"` | `src/session/agent-session.ts:1-40` |
| `pi-natives` 是什么 | **NAPI-RS 原生 `.node` 二进制**，123 个导出符号 | `pi-natives/native/index.js` |
| `pi-natives` 加载器 | 首行 `import * as childProcess from "node:child_process"`，靠 `createRequire` 探测 `~/.omp/natives` 或包内 `.node` | `pi-natives/native/loader-state.js:1-9` |

**依赖分层（官方自己的包结构，这是"能不能进 Webview"的真正判据）：**

| 包 | 职责 | `node:fs` 文件数 | `pi-natives` 依赖 | 能否进 Webview |
|---|---|---|---|---|
| `pi-agent-core` | 会话骨架、turn 循环、tokenizer | **0** | 仅 `tokenizer.ts`（`countTokens`） | 差一步：tokenizer 换纯 JS 即可 |
| `pi-ai` | LLM 流式、provider、auth | **13**（全在 auth/provider 路径） | 4 处（auth cascade、Apple FM、OAuth native callback） | 差多步：13 处 fs + 4 处 natives 要替换 |
| `pi-coding-agent` | 工具集、技能、MCP、LSP、任务系统 | **224** | `agent-session.ts` 顶层 + `Shell`/`grep`/`glob`/`EditStore`/`highlightCode` 等 | **不可行**：bash/edit/grep/glob/listWorkspace 全部走 `pi-natives` 的 `.node` |

`Shell`、`PtySession`、`executeShell`、`grep`、`glob`、`listWorkspace`、`EditStore`、`countTokens`、`highlightCode` 全部来自 `pi-natives` 的 `.node`。而 `.node` 是 V8 C++ ABI 二进制，**只有 Node/Bun 能 `dlopen`，Webview2/WebKit 不能，也没有 `createRequire`**。

### 0.2 官方"进程内集成"到底嵌在什么宿主里

官方 SDK 的设计初衷确实是**进程内集成**——但"进程内"指的是**进程内的 Node/Bun 宿主**，不是浏览器/Webview：

- `examples/sdk/README.md` 12 个例子（`01-minimal.ts` 到 `12-full-control.ts`）全部是 `createAgentSession()` 直接跑在 `npx tsx` / Bun 里，`SessionManager.create(cwd)` 直接写文件。
- `package.json` 没有 `browser` 字段，没有任何 Web 构建产物。
- 官方自己的 `omp` CLI（`bin: {"omp": "dist/cli.js"}`）就是最大的"进程内集成者"——它 import `sdk.ts`，`sdk.ts` import `agent-session.ts`，整条链都在 Node/Bun 里。

**结论：官方推荐方案 = "在你的 Node/Bun 进程里 `createAgentSession()`"。** 这与我们的目标完全一致——我们只是把官方 CLI 这个宿主，换成了自己的 Rust 桌面应用。官方没有、也不打算支持 Webview 宿主。

---

## 1. 判断：为什么直接集成，且为什么选择"去 NDJSON 透传层 + 保留 Bun 运行时"

### 1.1 直接集成的收益（在单一 agent 前提下成立）

- **少一层进程间协议**：不再有 NDJSON stdin/stdout、单行 1 MB 上限、命令-应答配对。
- **少一个 190 MB 编译产物**：不再编 `poietica-agent-<triple>.exe`，Bun 运行时是独立分包，SDK 与 bridge 源码随包发。
- **少一次序列化**：SDK 的 typed event 不再先 JSON 化再被 Rust 解回再 JSON 化给前端。
- **延迟更低**：prompt/事件不再跨进程编解码，取消与授权答复少一跳。
- **代码更集中**：agent 专属知识只住 `packages/agent-bridge`，Rust 不再持有 `wire.rs` 这份线上形状的副本。
- **改完即生效**：桥代码改一行不用重编 exe，开发-测试-发版周期缩短。

### 1.2 为什么不是"Rust 直连 omp stdout"

那是一条更差的路：

1. **翻译层会污染通用层**。omp 没有增量 transcript 协议，屏幕经过是 `session.subscribe` 的 typed event 投影出来的（`packages/agent-bridge/src/main.ts:522` 起）。在 Rust 里重写这层投影，等于把协议判别写进通用层，撞 AGENTS.md §4「通用层出现 `if agent_id == "某家"` 即为缺陷」。
2. **deno_core 没有 Node ABI**。omp SDK 依赖 `node:fs`、`node:child_process`、`Bun.spawn` 以及 `pi-natives`（NAPI-RS `.node`）。在 Rust 里嵌 deno_core 要逐一手工桥接，是一个独立子项目。
3. **编译与产物更重**。deno_core + V8 的编译时长与 maturation 成本远超 Bun 运行时。

### 1.3 为什么不是"SDK 进 Webview"

实测证据（§0.1）已经钉死：SDK 源码树 224 个文件 import `node:fs`，330 个文件用 Bun API，42 处 spawn 子进程，`agent-session.ts` 顶层就 `import … from "node:fs"` 并依赖 `pi-natives`（NAPI 原生二进制）。Webview2/WebKit 没有 Node API、不能 `dlopen .node`、没有 `createRequire`。这条路不是 shim 一两个模块能跨过去的——是要为整个 SDK 重写运行时。成本与风险远超收益，否决。

### 1.4 结论

直接集成 = **去掉自有编译 exe 与 Rust 的 NDJSON 透传层，让 `packages/agent-bridge` 成为前端直调的一个普通包，SDK 随包分发的 Bun 运行时承载**。

Rust 只保留它本来就该有的：本地账本、落盘附件、IPC 转发。`node:fs`、`Bun.spawn`、`pi-natives` 全部原样可用，零移植成本。

---

## 2. 目标架构

### 2.1 进程与模块边界

```text
Tauri Webview (ES2021+, 前端沙箱)
  ├─ @poietica/native-bridge →  Tauri IPC
  └─ transcript-store / projectTranscript / React

Bun 运行时（随包分发，与 Poietica 版本锁死）
  └─ @poietica/agent-bridge  →  import @oh-my-pi/pi-coding-agent   (SDK + pi-natives(.node) 在这里)

Rust (src-tauri)，只剩本地事实：
  帧日志/账本 (conversation_events)
  落盘附件 (assets/)
  受控 home 路径发放 (paths.rs)
  Bun 进程的启动与监督
```

### 2.2 一条纪律：SDK 与 bridge 只跑在 Bun 里

bridge 与 SDK 是 **Bun 代码**，不是 Web 代码。它们照常 `import "node:fs"`、`Bun.spawn`、`pi-natives`（`.node`）。**禁止**为了让它们进 Webview 而改写这些调用——实测证据（§0.1）已经证明那是重写整个运行时，不是集成。

Webview（前端）与 Bun（bridge）的边界就是本方案的接缝：前端只调 `createBridge()` 返回的方法，不 import SDK；Bun 进程只承载 bridge，不渲染 UI。这条边界由分层检查强制执行（见 §6）。

---

## 3. 现状与目标的数据流对照

### 3.1 命令路（prompt）

**现在：**
React → native-bridge → Tauri command → agent-client → NDJSON stdin → main.ts → SDK

**之后：**
React → native-bridge → Tauri command（仅记帧日志 + 转发）→ 前端 bridge → SDK

`agent-client` 的 `Recorder`、`RunSlot`、`SessionBook` 不再存在；幂等、准入、投递由 src-tauri 的 `conversation` 模块直接落 `conversation_events` 表。

### 3.2 事件路（turn）

**现在：**
SDK event → main.ts 投影 → stdout NDJSON → agent-client 解码 → SessionEvent → Tauri emit → native-bridge transcript 端口 → transcript-store

**之后：**
SDK event → bridge.subscribe 投影 → transcript-store

transcript 的形状不变（仍是 `packages/transcript` 钉住的 `transcript.ops` / `transcript.reset`），变的只是从"跨进程 NDJSON"变成"同进程函数返回"。

---

## 4. 具体改动

### 4.1 要删除的

| 路径 | 原因 |
|---|---|
| `crates/agent-client/` | 整个 crate 退役。落账与幂等搬进 `apps/desktop/src-tauri/src/conversation/` |
| `packages/agent-bridge/src/main.ts` | 边车入口，不再需要 |
| `packages/agent-bridge/src/protocol.ts` 的 NDJSON 信封 | 不再需要线上协议 |
| `packages/agent-bridge/src/protocol.ts` 的 `BRIDGE_PROTOCOL_VERSION` | 没有版本协商对象了 |
| `tools/agent/build-bridge.ts` | 不再编 exe |
| `apps/desktop/src-tauri/tauri.conf.json` 的 `externalBin` | 不再发边车 |
| `crates/agent-client/src/wire.rs` | 不再需要 NDJSON 编解码 |
| `crates/agent-client/src/process/` 的 `supervisor.rs`、`daemon.rs`、`install.rs` | 不再起子进程 |
| `crates/agent-client/src/session/bridge.rs` | 不再需要传输驱动器 |
| `ProcessEnvironment`、`hide_console`、`resolve_sidecar` | 不再 spawn |

### 4.2 要新建的

#### `packages/agent-bridge/src/index.ts` 改为导出工厂

`BridgeHost` 提供**环境上下文**，不是 fs 抽象——SDK 自己读写 `node:fs`，不需要宿主代劳：

```ts
export interface BridgeHost {
  /** 受控 home 的绝对路径，由 native-bridge 发放（对应 PI_CODING_AGENT_DIR） */
  agentDir: string
  /** 工作区根目录 */
  cwd: string
  /** 需要覆盖的环境变量（白名单键） */
  env?: Readonly<Record<string, string>>
}
```

`createBridge(host)` 返回的方法面与现状的 `BridgeCommand`/`BridgeEvent` 一一对应（`newSession`/`loadSession`/`prompt`/`cancel`/`steer`/`answerPermission`/`answerDialog`/`select`/`transcript`/`transcriptOps`/`sessions`/`forkSession`/`deleteSession`/`exportSession`/`settingsCatalog`/`setSetting`/`modelCatalog`/`capabilities`/`skills`/`mcpServers`/`browserSettings`/`setBrowserSettings`/`subscribe`）。事件通过 `subscribe(sessionId, listener)` 回调暴露，不再 emit 到 stdout。

`host.agentDir` 由前端在启动时从 native-bridge 拉取；`Settings.init()`、`SessionManager`、`ModelRegistry` 仍用 SDK 自带的 `node:fs` 读写，路径由 `PI_CODING_AGENT_DIR` 指到 `host.agentDir`。

#### `apps/desktop/src-tauri/src/conversation/ledger.rs`（新）

把 `crates/agent-client/src/recorder.rs` 的幂等、准入、投递逻辑搬进来，直接操作 `conversation_events` 表。`RunSlot` 与 `SessionBook` 的内存态由 `Runtime` 持有，不再跨进程。

### 4.3 要改写的

| 路径 | 改动 |
|---|---|
| `packages/agent-bridge/src/settings.ts` | 原样保留（已是纯 TS，读写走 SDK 的 `node:fs`） |
| `packages/agent-bridge/src/models-file.ts` | 原样保留 |
| `packages/agent-bridge/src/catalog.ts` | 原样保留 |
| `packages/agent-bridge/src/approval.ts` | 保留 DialogDesk，但不再 emit 到 stdout，改为回调 |
| `packages/agent-bridge/src/projection.ts` | 原样保留，输出直接进 transcript-store |
| `packages/agent-bridge/src/transcript-mirror.ts` | 原样保留，作为内存镜像 |
| `apps/desktop/src/entry/compose-agent.ts` | 不再走 `AgentClient`，改为 `createBridge(host)` |
| `apps/desktop/src/assistant/agent-runtime.ts` | 同上 |
| `packages/native-bridge/src/conversation/session.ts` | transcript 端口不再从 Tauri event 收，改为从 bridge.subscribe 收 |
| `apps/desktop/src-tauri/src/conversation/turn.rs` | `agent_transcript` / `agent_transcript_ops` 改为直接调前端 bridge（或干脆由前端直读，Tauri 只记日志） |
| `apps/desktop/src-tauri/src/conversation/config.rs` | `agent_capabilities` 等改为前端直读 SDK，Tauri 不再代理 |

---

## 5. 四个必须钉死的面

### 5.1 文件系统

SDK 的 `SessionManager`、`Settings`、`ModelRegistry` 继续用 `node:fs` 读写 `PI_CODING_AGENT_DIR`（= `host.agentDir`）。**不改 SDK 的 fs 调用**——224 个文件的移植成本已在 §0.1 钉死。受控 home 的目录由 native-bridge 的 `paths.rs` 发放，Bun 进程启动时经 `PI_CODING_AGENT_DIR` 环境变量传入。

### 5.2 环境变量

`PI_CODING_AGENT_DIR` 仍通过环境变量传递，但不再是 spawn 一个 exe 时的 env，而是 Bun 运行时启动 bridge 时的 env。`BridgeHost.env` 白名单只允许产品需要的键（如 `PI_NO_TITLE`、`PI_CODING_AGENT_DIR`），其余不注入。

### 5.3 密钥

`AuthStorage` 与 `agent.db` 的读写仍由 SDK 自己管，底层就是 `node:fs`。密钥**不进入前端 JS 堆**的原则不变：`setApiKey` 等操作由 bridge 方法调 SDK 内部完成，前端不读取明文。

### 5.4 原生模块

`pi-natives`（`.node`）随包分发，Bun 运行时按 `pi-natives/native/loader-state.js` 的既有逻辑加载（先探测 `~/.omp/natives`，再回落到包内 `pi-natives-win32-x64` 等目录）。**不编译进 exe**，因此不需要 `PI_COMPILED` define，也不需要 `embedded-addon.js` 的提取路径。标题生成、STT/TTS、语义搜索等依赖 `transformers`/`onnxruntime` 的路径保持现状：默认关闭（`PI_NO_TITLE=1`），需要时由用户显式开启。

---

## 6. 不变量怎么守

- **屏幕经过仍走 agent 的 transcript**：形状不变，仍是 `packages/transcript` 的 ops/reset。
- **每类状态仍单写者**：删 `agent-client` 后，`turns` 表与 `conversation_events` 的写者只剩 src-tauri 的 `conversation` 模块。
- **密钥永不落盘**：`agent.db` 仍在受控 home，由 SDK 用 `node:fs` 读写，密钥不经过前端 JS 堆。
- **agent 专属知识仍只在两处**：`agent-catalog` 的档案（数据）与 `agent-bridge` 的代码。通用层不出现 `if agent_id === 'omp'`。
- **一次换干净**：删 `agent-client` 与 `main.ts` 必须同一次改动完成，不留兼容层。
- **前端/后端边界由分层检查执行**：`apps/desktop/src`（Webview 代码）不允许 `import "@oh-my-pi/pi-coding-agent"` 或任何 `node:*` 模块；`packages/agent-bridge` 只允许被 `apps/desktop/src/entry/compose-agent.ts` 这类组合根 import，不允许被 UI 组件 import。这条规则进 `tools/architecture/layering.ts`。

---

## 7. 分阶段实施

### P0：拆 `createBridge(host)`（前置）

- 把 `packages/agent-bridge/src/main.ts` 的 NDJSON 循环改成 `createBridge(host)` 工厂，事件通过回调暴露。
- 保留 `projection.ts`、`transcript-mirror.ts`、`approval.ts`、`settings.ts` 等核心模块原样（它们已经是纯 TS，不依赖 stdout）。
- 前端在 `compose-agent.ts` 里直接 `createBridge(host)`，不再经过 Tauri。

### P1：删 Rust 透传层

- 删 `crates/agent-client/src/wire.rs`、`crates/agent-client/src/session/bridge.rs`、`crates/agent-client/src/process/`。
- `crates/agent-client/src/recorder.rs` 的幂等、准入、投递逻辑搬进 `apps/desktop/src-tauri/src/conversation/ledger.rs`。
- `Runtime` 不再 spawn，直接持有 bridge 实例。

### P2：删编 exe，换 Bun 运行时

- 删 `tools/agent/build-bridge.ts`。
- 从 `tauri.conf.json` 删掉 `externalBin`。
- CI 里删掉 `bun run build:bridge`。
- 新增 `tools/agent/prepare-runtime.ts`：下载与 Poietica 版本锁死的 Bun 运行时，连同 `packages/agent-bridge` 与 `node_modules` 一起打进资源目录。
- `agent-catalog` 的 `command` 从 `poietica-agent` 改为 `bun`（或 `bun.exe`），`args` 改为 `["run", "<bridge-entry>"]`。

### P3：验证

- transcript 形状逐字不变（用 `packages/transcript` 的 schema 校验）。
- 取消不挂死：发 prompt 后立刻 cancel，UI 能收到 `turn_end` 且状态正确。
- 密钥不进前端 JS 堆：抓包确认 `agent.db` 的读写不经过 Webview。
- `tauri build` 产物里没有 `poietica-agent*.exe`，Bun 运行时体积远小于 190 MB。
- `bun run check` 全绿。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Bun 运行时版本漂移导致行为不一致 | 运行时与 Poietica 版本锁死，由 `tools/agent/prepare-runtime.ts` 下载固定版本；用户机器上的 Bun 不参与 |
| `pi-natives` 的 `.node` 在某些平台缺预编译包 | `pi-natives` 官方为 win32-x64、linux-x64、darwin-x64、darwin-arm64 都发预编译包（见 `loader-state.js` 的 `SUPPORTED_PLATFORMS`）；缺的平台在 `prepare-runtime.ts` 里报错，不静默降级 |
| 取消与超时不再有进程边界兜底 | SDK 的 `session.cancel()` 是协作式的，bridge 用 `AbortController` 与超时 Promise 实现；Bun 进程本身由 Rust 的 supervisor 重启 |
| 密钥意外进入前端 JS 堆 | `setApiKey` 等操作由 bridge 方法调 SDK 内部完成，前端不读取；`agent.db` 的读写不经过 Webview |
| 分层检查没拦住 Webview import SDK | P0 阶段在 `tools/architecture/layering.ts` 里加一条规则：`apps/desktop/src` 不允许 import `@oh-my-pi/*` 或 `node:*` |

---

## 9. 验收标准

1. 打开一条旧会话，能回放完整 transcript。
2. 发一轮新对话，能收到增量 ops 与 `turn_end`。
3. 点「批准」能真的让下一次 write/exec 过闸。
4. 断网、取消、超时三种收尾，UI 不挂死。
5. `tauri build` 产物里没有 `poietica-agent*.exe`，Bun 运行时体积远小于 190 MB。
6. `bun run check` 全绿。

---

## 10. 与 ADR 0052 的关系

本文**取代** ADR 0052 的"SDK 编进我们自己的二进制"决定，但**继承**它的核心洞察：

- 屏幕经过的产地必须在能看见 SDK typed event 的地方。
- 用户不装任何 CLI，只装 Poietica。
- omp 没有增量协议，增量由我们自己投影。

变的是：产地从"我们编的 exe"变成"随包分发的 Bun 运行时跑 bridge 源码"，而不是从"TS"变成"Rust"。

---

## 11. 拍板记录（2026-09，不再回问）

用户要求"两件事你自己决定"。以下决策基于 §0.1 的实测证据，已按 AGENTS.md §8「一次换干净」的纪律定稿：

**决策一：放弃"SDK 直接进 Webview"路线。** 官方"进程内集成"的"进程"是 Node/Bun 进程，不是 Webview 进程。实测证据（§0.1）证明：SDK 的 224 个 `node:fs` 文件、330 个 Bun API、42 处 spawn 以及 `pi-natives`（NAPI `.node`）全部依赖 Node/Bun 宿主 ABI；Webview2/WebKit 没有这些。把 SDK 塞进 Webview 不是集成，是为整个 SDK 重写运行时。否决。

**决策二：SDK 的宿主从"自有编译 exe"改为"随包分发的 Bun 运行时跑 bridge 源码"。** 这是**官方推荐方案**（`examples/sdk/README.md:01-minimal.ts` 到 `12-full-control.ts` 全是这个模式）。不再用 `Bun.build({compile})` 编 190 MB 单文件，改为发一个与 Poietica 版本锁死的 Bun 运行时 + bridge 源码。理由：
- 官方设计的就是"在你的 Node/Bun 进程里 `createAgentSession()`"；我们用 Bun 运行时承载，正是官方推荐的进程内集成方式。
- 运行时与 Poietica 版本锁死，"用户机器上 Bun 版本漂移"不存在；
- 去掉编译步骤与 externalBin，CI/发版/调试都变简单；
- 桥代码改完即生效，不用重编 exe；
- `pi-natives` 的 `.node`、SDK 的 `node:fs`、`Bun.spawn` 全部原样可用，零移植成本。
