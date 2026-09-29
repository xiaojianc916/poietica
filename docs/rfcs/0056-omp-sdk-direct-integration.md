# 0056 — omp SDK 直接集成（去自有编译 exe）

状态：**已全部落地**（P0/P1/P2/P3）。触发：用户明确要求"直接集成"，且产品只接 omp 一家 agent。

本文定义"直接集成"的准确含义，并**取代** ADR 0052 的"SDK 编进我们自己的二进制"决定。
落地形态见 ADR 0057。

> **口径（2026-09 勘误）**：本文早期草案写的是"让 `packages/agent-bridge` 成为前端直调的一个普通包"。
> 那句话与本文 §0.1/§1.3 自己的结论矛盾 —— SDK 进不了 Webview，前端与 bridge 之间永远隔着进程边界。
> 已删。真实形态见 §1.4：**bridge 从"脚本"变成"库"（`createBridge(host)`），进程与一条 stdio 传输保留**。

---

## 0. 先厘清一个事实

当前仓库里**没有 omp 官方 CLI 边车**，也**没有我们自己的编译产物**。`agent-catalog` 档案里
`command: 'bun'` + `entry: 'poietica-bridge.js'` 指的是 `apps/desktop/src-tauri/binaries/` 里那两份：
随包发的 Bun 运行时，与 `tools/agent/prepare-runtime.ts` 用 `Bun.build({target:'bun'})` 收出来的桥
bundle（omp SDK 编在里面）。两者一起摆到安装目录（`bundle.resources`），用户不装任何东西。

所以"边车 vs 直接集成"的真实差别只剩一层：**我们与 bridge 之间隔着多少东西**。今天是
"Rust → spawn Bun → 桥 bundle（stdio 适配器）→ `createBridge(host)` → SDK"，中间没有编译产物。

### 0.1 决定可行性的实测证据（2026-09，锚定 omp 18.3.0）

宿主耦合度与"能不能进 Webview"，都在动手前先钉死。

**宿主耦合度（`packages/agent-bridge/node_modules/@oh-my-pi/pi-coding-agent` 全树统计）。**
下表的谓词是逐条给全的 —— "224 个 node:fs 文件"这句话少一个谓词就会与 109 冲突：

| 探测点 | 结果 | 谓词 |
|---|---|---|
| `node:fs` import | **109 个文件** | `(from\|import) … ['"](node:)?fs['"]` |
| `node:fs` + `node:fs/promises` | **224 个文件** | 同上，另加 `/promises` |
| Bun API | **323 个文件** | `Bun.` 或 `['"]bun:` |
| `Bun.spawn` | **32 个文件**（53 处） | 调用点计数 |
| 裸 `spawn(` | **43 个文件**（80 处） | 含包装器 |
| `node:child_process`（本包内） | **0 个文件** | 只在 `pi-natives` 的加载器里 |
| `agent-session.ts` 顶层 | `:16 import * as fs from "node:fs"`；`:88` 引 `@oh-my-pi/pi-natives` | `src/session/agent-session.ts` |
| `pi-natives` 是什么 | **NAPI-RS 原生 `.node`** | `pi-natives/package.json` 的 `napi.binaryName` |
| `pi-natives` 加载器 | `createRequire` + `node:child_process`，探测 `~/.omp/natives` | `native/loader-state.js:1,3,59-65,957-971` |
| `pi-natives` 支持平台 | linux/darwin/win32 × x64/arm64（6 个） | `native/loader-state.js:35-42` |
| 预编译原生二进制 | **174.6 MB**（win32-x64） | `@oh-my-pi/pi-natives-win32-x64/pi_natives.win32-x64-baseline.node` |
| SDK 包自身体积 | **49.1 MB** | `pi-coding-agent` 全树 |

引 `@oh-my-pi/pi-natives` 的文件共 **103 个**，导入符号 **80 个**。`Shell`、`PtySession`、`executeShell`、`grep`、`glob`、`listWorkspace`、`EditStore`、`countTokens` 全部来自它。
（`highlightCode` 不在其中：它由 `@oh-my-pi/pi-tui` 提供，早期草案把它算进 pi-natives 是记错了。）

`Shell`、`grep`、`glob` 这些能力全部走 `pi-natives` 的 `.node`。而 `.node` 是 V8 C++ ABI 二进制，**只有 Node/Bun 能 `dlopen`，Webview2/WebKit 不能，也没有 `createRequire`**。

**官方自己的清单也这么说**：`package.json` 的 `engines` 只有 `{"bun": ">=1.3.14"}`，没有 `browser` 字段，也没有 `browser`/`deno`/`worker` 导出条件，117 个 `exports` 键全部指向 `src/*.ts`。持久层走 `bun:sqlite`（12 个文件）。

### 0.2 官方"进程内集成"到底嵌在什么宿主里

官方 SDK 的设计初衷确实是**进程内集成**——但"进程内"指的是**进程内的 Node/Bun 宿主**，不是浏览器/Webview：

- `examples/sdk/` 随包发货（13 个例子 + README），全部是 `createAgentSession()` 直接跑在 Bun 里，`SessionManager.create(cwd)` 直接写文件。`01-minimal.ts` 的核心就是 `const { session } = await createAgentSession()` + `session.subscribe(...)` + `await session.prompt(...)`。
  **（勘误）** `examples/sdk/README.md` 里列了 `05-tools.ts`、`10-settings.ts`、`12-full-control.ts`，但**这三个文件在 18.3.0 的包里不存在** —— README 比实际多列了。以 `ls examples/sdk` 的结果为准。
- `engines` 只认 bun（见 §0.1）。
- 官方自己的 `omp` CLI（`bin: {"omp": "dist/cli.js"}`）就是最大的"进程内集成者"——它 import `sdk.ts`，`sdk.ts` import `agent-session.ts`，整条链都在 Node/Bun 里。

**结论：官方推荐方案 = "在你的 Node/Bun 进程里 `createAgentSession()`"。** 这与我们的目标完全一致——我们只是把官方 CLI 这个宿主，换成了自己的 Rust 桌面应用 spawn 的 Bun 进程。官方没有、也不打算支持 Webview 宿主。

---

## 1. 判断：为什么直接集成，且为什么保留进程与一条传输

### 1.1 直接集成的收益（在单一 agent 前提下成立）

- **去掉自有编译管线**：不再走 `Bun.build({compile})`，连带 `PI_COMPILED` define、bytecode、`embedded-addon.js` 的提取路径一起消失。
- **少一层自有协议语义**：`main.ts` 从"边车入口"降为"stdio 适配器"，命令的判别与执行收在 `bridge.ts` 一处（P0 已落地）。
- **代码更集中**：agent 专属知识只住 `packages/agent-bridge`。

**（勘误，本轮实测）早期草案写的体积与耗时两条都是错的，且现状比草案以为的更大。**

现状那份 187.7 MB 的 exe **不是自包含的**：`pi-natives` 的 `.node` **没有**嵌进去。
证据（2026-09，win32-x64，Bun 1.4.2）三条独立：

1. 包内 `pi-natives/native/embedded-addon.js:31` 是 `export const embeddedAddon = null;`
   —— 编译期嵌入这条路的载荷是空的，`maybeExtractEmbeddedAddon` 因此恒返回 null。
2. 加载器 `native/loader-state.js:347`（`shouldStageNodeModulesAddon`）对
   `isCompiledBinary` **直接返回 false**：编出来的二进制不会从 `node_modules` 取。
   于是它只剩 `~/.omp/natives/<版本>/`、`%LOCALAPPDATA%\omp`、以及
   `path.dirname(process.execPath)` 三处候选（`resolveLoaderCandidates`）。
3. 行为实测：把 `~/.omp/natives` 移开、把 `USERPROFILE`/`LOCALAPPDATA` 指到空目录，
   直接跑那个 exe → `Failed to load pi_natives native addon for win32-x64`。
   把 `pi_natives.win32-x64-baseline.node` 放到 exe 旁边（同一目录）→ 立刻 `ready`。
   字节级复核：取 `.node` 中段 256 字节到 exe 里搜，**0 命中**。

那份缓存是**跑源码版桥**时被 stag 进去的（`shouldStageNodeModulesAddon` 对非编译包返回
true），不是 exe 自己解的。也就是说：**今天在干净机器上装出来的 Poietica，agent 起不来**，
而在开发机上被那份缓存掩盖了。这是本轮发现的一个**独立缺陷**，任何形态的 P1 都要顺手修掉
（把 `.node` 随包发到 `process.execPath` 那个目录即可）。

按此修正，三条形态的真实体积：

| | 组成 | 合计 |
|---|---|---|
| 现状（修好原生模块之后） | exe 187.7 + `.node` 174.6 | **≈ 362 MB** |
| A 发源码 | `bun.exe` 82 + 源码 + `node_modules` 闭包 673 | **≈ 755 MB** |
| B 发 bundle | `bun.exe` 82 + bundle 36 + `.node` 175 | **≈ 293 MB** |

**这翻转了草案的结论。** 草案把现状记成 187.7 MB、把"换运行时"说成省体积，两条都错；
修正现状（362 MB）之后，**形态 B 反而比现状小约 19%**，且同时去掉 187 MB exe 的
`compile` 步骤与 bytecode，代价是随包多一个 `bun.exe`。形态 A（草案 §7-P1 原本写的
"连同 `node_modules` 一起打进资源目录"）是 755 MB，**不该选**。

其它实测数字：

| | 实测 |
|---|---|
| `Bun.build({compile})` 耗时 | **4.0 秒**（草案按"编译慢"立论，实测很快） |
| bridge 打成 bundle（`target: 'bun'`） | **36.0 MB、0.6 秒**；但**必须**把 `.node` 一起发（否则同一个 `Failed to load pi_natives`） |
| `--omit=optional` 对闭包的效果 | 879.4 → 673.5 MB（`onnxruntime-node` 287 MB、`onnxruntime-web` 135 MB 由 `@oh-my-pi/pi-mnemopi` 拖进来，而 mnemopi 在 SDK 里是按需动态 import；bun 没有"按需依赖"这个档位） |


### 1.2 为什么不是"Rust 直连 omp stdout"

那是一条更差的路：

1. **翻译层会污染通用层**。omp 没有增量 transcript 协议，屏幕经过是 `session.subscribe` 的 typed event 投影出来的（`packages/agent-bridge/src/bridge.ts` 的 `handleEvent`）。在 Rust 里重写这层投影，等于把协议判别写进通用层，撞 AGENTS.md §4「通用层出现 `if agent_id == "某家"` 即为缺陷」。
2. **deno_core 没有 Node ABI**。omp SDK 依赖 `node:fs`、`Bun.spawn`、`bun:sqlite` 以及 `pi-natives`（NAPI-RS `.node`）。在 Rust 里嵌 deno_core 要逐一手工桥接，是一个独立子项目。
3. **编译与产物更重**。deno_core + V8 的编译时长与 maturation 成本远超 Bun 运行时。

### 1.3 为什么不是"SDK 进 Webview"

实测证据（§0.1）已经钉死：SDK 源码树 109 个文件 import `node:fs`（含 `node:fs/promises` 224 个），323 个文件用 Bun API，`agent-session.ts` 顶层就 `import … from "node:fs"` 并依赖 `pi-natives`（NAPI 原生二进制），`engines` 只认 bun。Webview2/WebKit 没有 Node API、不能 `dlopen .node`、没有 `createRequire`。这条路不是 shim 一两个模块能跨过去的——是要为整个 SDK 重写运行时。成本与风险远超收益，否决。

### 1.4 结论

直接集成 = **去掉自有编译 exe，让 `packages/agent-bridge` 从"边车脚本"变成"库"：`createBridge(host)` 交出调用面，SDK 与桥源码由随包分发的 Bun 运行时承载**。

**进程边界与一条传输保留。** Webview 与 Bun 是两个 JS 引擎，没有共享堆；bridge 进不了 Webview（§1.3），所以两者之间必然有一条通道。这条通道今天就在：Rust 的 `agent-client` spawn 那个 Bun 进程，用 NDJSON stdin/stdout 说话。删掉它不会让边界消失，只会让边界没人守着。

Rust 只保留它本来就该有的：本地账本、落盘附件、IPC 转发、Bun 进程的启动与监督。`node:fs`、`Bun.spawn`、`pi-natives` 全部原样可用，零移植成本。

---

## 2. 目标架构

### 2.1 进程与模块边界

```text
Tauri Webview (ES2021+, 前端沙箱)
  ├─ @poietica/native-bridge →  Tauri IPC
  └─ transcript-store / projectTranscript / React

Bun 进程（随包分发，与 Poietica 版本锁死）
  ├─ poietica-bridge.js  = src/main.ts      stdio 适配器：一行一条 JSON ⇄ 调用面
  └─                    →  src/bridge.ts    createBridge(host)
                          →  import @oh-my-pi/pi-coding-agent
                                 (SDK + pi-natives(.node) 在这里)

Rust (src-tauri)，只剩本地事实：
  帧日志/账本 (conversation_events)
  落盘附件 (assets/)
  受控 home 路径发放 (paths.rs)
  Bun 进程的启动与监督 (agent-client)
```

三样随包发的东西（Bun 运行时、`poietica-bridge.js`、`pi_natives.*.node`）由
`bundle.resources` 摆进安装目录，与 `poietica.exe` 同目录：运行时的同目录是
pi-natives 加载器 `execDir` 候选的唯一无条件落点，而桥的入口只从那里找。

### 2.2 一条纪律：SDK 与 bridge 只跑在 Bun 里

bridge 与 SDK 是 **Bun 代码**，不是 Web 代码。它们照常 `import "node:fs"`、`Bun.spawn`、`pi-natives`（`.node`）。**禁止**为了让它们进 Webview 而改写这些调用——实测证据（§0.1）已经证明那是重写整个运行时，不是集成。

`apps/desktop/src`（Webview 代码）不允许 `import "@oh-my-pi/*"` 或任何 `node:*`。这条由 `tools/architecture/layering.ts` 与 `desktop-boundaries.ts` 执行（见 §6）。

---

## 3. 现状与目标的数据流对照

### 3.1 命令路（prompt）

**旧形态：** React → native-bridge → Tauri command → agent-client → NDJSON stdin → `packages/agent-bridge` 的编译产物（整份都在这儿）→ SDK

**新形态：** React → native-bridge → Tauri command → agent-client（记帧日志 + 准入）→ NDJSON stdin → `poietica-bridge.js`（只编解码）→ `bridge.dispatch` → SDK

命令清单**不变**，仍是 `protocol.ts` 的 `BridgeCommand`（与 `wire.rs` 逐字对应）。准入、幂等、落账仍由 `agent-client` 的 `Recorder` 拥有（§4.3）。

### 3.2 事件路（turn）

**旧形态：** SDK event → 编译产物里的投影 → stdout NDJSON → agent-client 解码 → SessionEvent → Tauri emit → native-bridge transcript 端口 → transcript-store

**新形态：** SDK event → `bridge.ts` 投影 → `subscribe` 回调 → `main.ts` 写 stdout → agent-client 解码 → SessionEvent → Tauri emit → native-bridge transcript 端口 → transcript-store

transcript 的形状不变（仍是 `packages/transcript` 钉住的 `transcript.ops` / `transcript.reset`），变的只是投影从"边车入口"搬进"库"。

---

## 4. 具体改动

### 4.1 已删除

| 路径 | 原因 |
|---|---|
| `packages/agent-bridge/src/main.ts` 的边车主体（1900 行） | 搬进 `src/bridge.ts` 的 `createBridge(host)`；`main.ts` 降为 87 行 stdio 适配器 |

### 4.2 已新建

#### `packages/agent-bridge/src/bridge.ts`

`BridgeHost` 提供**环境上下文**，不是 fs 抽象——SDK 自己读写 `node:fs`，不需要宿主代劳：

```ts
export interface BridgeHost {
  /** 受控 home 的绝对路径，对应 PI_CODING_AGENT_DIR */
  readonly agentDir: string
  /** 工作区根目录；会话没带 cwd 时用它兜底 */
  readonly cwd: string
  /** 要覆盖的环境变量，只放白名单键 */
  readonly env?: Readonly<Record<string, string>>
}
```

`createBridge(host)` 交出四个成员，事件经 `subscribe(listener)` 回调：

```ts
export interface Bridge {
  readonly dispatch: (command: BridgeCommand) => Promise<unknown>
  readonly subscribe: (listener: BridgeListener) => () => void
  readonly agentVersion: string
}
```

**刻意不铺一层同名方法**（`newSession()` / `prompt()` / …）：那 24 个方法里 23 个没有第二个调用方，而它们会把命令清单抄成第二份（AGENTS.md §5「单一分发点」）。`dispatch` 收的就是 `BridgeCommand` 那个判别式联合——**命令清单本身**。

`host.agentDir` 的账在对不上时当场报错：SDK 的 agent 目录是**模块加载时**解析的（`pi-utils/src/dirs.ts:446-449` 读 `PI_CODING_AGENT_DIR`），对不上说明有人会写到用户自己的 `~/.omp`，宁可起不来。

### 4.3 保留（不搬、不删）

| 路径 | 理由 |
|---|---|
| `crates/agent-client/` 的 `recorder.rs`、`run_slot.rs`、`session/book.rs` | 幂等、准入、投递**不需要 AppHandle/State/Emitter**，按 AGENTS.md §3 必须住在 crate 里并有自己的单测。搬进 `src-tauri` 会同时违反那条规则与"薄组合根"的判据 |
| `crates/agent-client/` 的 `wire.rs`、`session/bridge.rs`、`process/` | §1.4：进程边界与传输保留。`bridge.rs` 的 driver 仍是帧的读者，`process/` 仍是进程的拥有者 |
| `packages/agent-bridge/src/{projection,transcript-mirror,approval,settings,catalog,models-file,questions,thinking,outcome}.ts` | 原样保留（已是纯 TS，不依赖 stdout） |
| `tools/agent/prepare-runtime.ts` 的打包配方知识 | 编译配方已随旧形态退役，但 json-parse-plugin 与 legacy-pi-stub 两个插件的理由跟着搬过来了 |

### 4.4 不追官方 RPC 模式

omp 官方确有 stdio 的 RPC / ACP 模式（`--mode rpc|acp|rpc-ui`，以及 `omp acp` 子命令）。**我们不切过去**：官方 RPC 的命令面里没有 `settings_catalog`、`model_catalog`、`mcp_servers`、`skills`、`delete_session`、`browser_settings` —— 我们一半的命令它不存在。追过去的结果是"官方协议 + 自定义扩展"两套并存，比现在单一的自定义协议更差。

"按官方"落实在 **SDK 用法**上（`createAgentSession()` + `session.subscribe()` + `Settings` / `ModelRegistry` / `SessionManager` 的既有写法，`bridge.ts` 已经是这么用的），**不落实在传输协议上**。我们自己的传输协议仍是 `protocol.ts` ↔ `wire.rs` 这一对。

---

## 5. 四个必须钉死的面

### 5.1 文件系统

SDK 的 `SessionManager`、`Settings`、`ModelRegistry` 继续用 `node:fs` 读写 `PI_CODING_AGENT_DIR`（= `host.agentDir`）。**不改 SDK 的 fs 调用**——109 个文件的移植成本已在 §0.1 钉死。受控 home 的目录由 `paths.rs` 发放，Bun 进程启动时经 `PI_CODING_AGENT_DIR` 环境变量传入（今天就是这么传的）。

### 5.2 环境变量

`PI_CODING_AGENT_DIR` 仍通过环境变量传递。`BridgeHost.env` 白名单只允许产品需要的键（如 `PI_NO_TITLE`、`PI_CODING_AGENT_DIR`），其余不注入。

### 5.3 密钥

`AuthStorage` 与 `agent.db` 的读写仍由 SDK 自己管，底层是 `bun:sqlite`。密钥**不进入前端 JS 堆**的原则不变：`setApiKey` 等操作由 bridge 方法调 SDK 内部完成，前端不读取明文。

### 5.4 原生模块

`pi-natives`（`.node`，win32-x64 174.6 MB）随包分发，Bun 运行时按
`pi-natives/native/loader-state.js` 的既有逻辑加载。**不编译进 exe**，因此不需要
`PI_COMPILED` define，也不需要 `embedded-addon.js` 的提取路径。

旧形态（自有编译 exe）**拿不到**那个 `.node`：

- 包内 `native/embedded-addon.js:31` 是 `export const embeddedAddon = null` ——
  编译期嵌入这条路的载荷是空的；
- 加载器 `native/loader-state.js` 的 `shouldStageNodeModulesAddon` 对
  `isCompiledBinary` **直接返回 false** —— 编出来的二进制不从 `node_modules` 取。

它只剩 `~/.omp/natives/<版本>/`、`%LOCALAPPDATA%\omp`、
`path.dirname(process.execPath)` 三处候选（`resolveLoaderCandidates`）。前两处是**用户目录**：
干净机器上没有；开发机上有，是因为跑**源码版**桥时被 stag 进去的（非编译包那条路返回 true）。
**实测**：移开 `~/.omp/natives`、`USERPROFILE`/`LOCALAPPDATA` 指向空目录，exe 报
`Failed to load pi_natives native addon for win32-x64`；把 `-baseline.node` 放到 exe 旁边即 `ready`。

新形态的落点：`tools/agent/prepare-runtime.ts` 把平台叶子包的 `.node` 与 Bun 运行时
摆在同一个目录，`tauri.conf.json` 的 `bundle.resources` 把它们一起摆到 `$INSTDIR` ——
那是加载器的 `execDir` 候选，也是**唯一在所有模式下都存在**的一格。

**为什么必须摘掉 `PI_COMPILED`（不是"不折"就够）**：`isCompiledBinary()` 的第一判据是
运行时环境（`pi-utils/src/env.ts:466-470`）。它一为真，`resolveLoaderCandidates`
（`loader-state.js:156-185`）的候选表就**多出两个用户目录并排在最前**
（`versionedDir` = `~/.omp/natives/<版本>/`、`userDataDir` = `%LOCALAPPDATA%\omp`）——
别人机器上残留的一份会盖过我们随包发的那个。所以它进了档案的 `unsetEnv`
（`packages/agent-catalog/src/omp/descriptor.ts`），由 agent-client 在 spawn 时摘掉。
（随包那份在两条分支下都会命中：`baseReleaseCandidates` 两者都并入。）

验收：模拟干净机器（两个用户目录都空）跑随包布局得 `ready` + `capabilities`（已通过）。

---

## 6. 不变量怎么守

- **屏幕经过仍走 agent 的 transcript**：形状不变，仍是 `packages/transcript` 的 ops/reset。
- **每类状态仍单写者**：`turns` 表与 `conversation_events` 的写者仍是 src-tauri 的 `conversation` 模块；准入与幂等仍是 `agent-client` 的 `Recorder`。
- **密钥永不落盘（我们的盘）**：`agent.db` 仍在受控 home，由 SDK 用 `bun:sqlite` 读写，密钥不经过前端 JS 堆。
- **agent 专属知识仍只在两处**：`agent-catalog` 的档案（数据）与 `agent-bridge` 的代码。通用层不出现 `if agent_id === 'omp'`。
- **一次换干净**：换运行时的同一次改动里删掉 `prepare-runtime` 的旧身（`build-bridge.ts`）与 `externalBin`，不留两条路。
- **前端/后端边界由分层检查执行**：`apps/desktop/src` 不允许 `import "@oh-my-pi/*"` 或任何 `node:*`；`packages/agent-bridge` 只允许被 Rust spawn（不是被 UI import）。

---

## 7. 分阶段实施

### P0：拆 `createBridge(host)`（已落地）

- `src/main.ts` 的 1900 行边车主体搬进 `src/bridge.ts` 的 `createBridge(host)`，导出 `Bridge` / `BridgeHost` / `BridgeListener`。
- `src/main.ts` 降为 stdio 适配器（87 行）：起桥、报 `ready`、按行读命令、把监听器接回 stdout。命令怎么执行它一行都不写。
- `src/index.ts` 的公开面**不含** `bridge.ts` / `main.ts`：它们拖得动整个 SDK，摆进出口清单会让只想要投影的调用方跟着吃下 SDK。
- 验收：`bunx tsc --noEmit` 干净；`bun test src` 95 个全绿；`bun run packages/agent-bridge/src/main.ts` 收 `{"id":"1","type":"sessions"}` 回 `ready` + `response`（实测通过）。

### P1：换运行时（**已落地，采纳形态 B**）

#### 顺带修掉的一个独立缺陷：旧 exe 在干净机器上起不来

旧形态（`poietica-agent-<triple>.exe`）**不含** `pi-natives` 的 `.node`：
包内 `embedded-addon.js` 的载荷是 `null`，加载器又对 `isCompiledBinary` 关闭了从
`node_modules` 取的那条路。它当时能跑，只因为开发机上 `~/.omp/natives/<版本>/` 里
那份缓存是**跑源码版桥**时被 stag 进去的。

后果：**在没跑过源码版桥的干净机器上，装出来的 Poietica 起不了 agent。**
形态 B 消除了这个缺口：`.node` 随包发在 Bun 运行时旁边，而
`path.dirname(process.execPath)`（`resolveLoaderCandidates` 的 `execDir`）是唯一
在所有模式下都存在的候选。

#### 形态比较（已实测，2026-09）

草案给 P1 的理由是"190 MB exe 编译慢（CI 慢）、改 bridge 要重编"。实测两条都不成立，
而修正旧形态体积之后，草案写的"A 发源码"反而是最差的一条：

| 形态 | 组成 | 合计 | 说明 |
|---|---|---|---|
| 旧形态（已修好原生模块） | exe 187.7 + `.node` 174.6 | **362.3 MB** | 仍是自有 `compile` 管线 |
| A 发源码 | `bun.exe` 82 + 源码 + `node_modules` 闭包 673 | **≈ 755 MB** | 闭包里 400+ MB 是死重 |
| **B 发 bundle（已采纳）** | `bun.exe` 82 + bundle 36 + `.node` 175 | **≈ 293 MB** | 最小，且不需要改原生模块那条修法 |

**形态 B 同时满足三件事**：比旧形态小约 19%；去掉自有 `compile` 管线；`.node` 落在
运行时同目录，加载器的 `execDir` 候选直接命中。

#### 已落地的清单（同一次改完，AGENTS.md §8）

- `tools/agent/prepare-runtime.ts`：把 `packages/agent-bridge/src/main.ts` 打成
  `target: 'bun'` 的 bundle，连同**正在跑脚本的那只 Bun** 与平台叶子包的 `.node`
  一起摆进 `apps/desktop/src-tauri/binaries/`（文件名原样，不带 triple）。
  配方照官方 SDK 包自己的 `bundle-dist` 构建脚本，两处不同都在注释里写了理由
  （空 `omp-legacy-pi-modules` 注册表、`PI_DOCS_EMBED` 折入）。
- `agent-catalog` 的档案改成两格：`command: 'bun'`（运行时，允许 PATH 回落）与
  `entry: 'poietica-bridge.js'`（入口，**只认随包目录**）。
  `homeVar` / `ownHomeDirectory` / `args` 不动；`unsetEnv` 多一格 `PI_COMPILED`。
- 删 `tools/agent/prepare-runtime.ts` 的前身（旧的 `agent:build` 编译脚本）、
  `tauri.conf.json` 的 `externalBin`、脚本 `agent:build`。
- `bundle.resources` 把三样摆到 `$INSTDIR`（与 `externalBin` 同目录，即 `execDir`）。

#### 两个必须写下来的实测结论

1. **不设 `PI_COMPILED`，并且要主动摘掉它。** `isCompiledBinary()` 的第一判据是
   **运行时环境**（`pi-utils/src/env.ts:466-470`），所以"构建期不折"不够。它一为真，
   三处按"编译态"改道（2026-09 实测）：pi-natives 的候选表**多出用户目录并排在最前**
   （别人机器上残留的一份会盖过我们随包发的那个）；SDK 的 CLI 入口块会在进程里跑起来
   （`src/cli.ts:601` 的 `isProcessEntry`，第二个入口抢同一根 stdout）；worker 子进程
   的启动命令换成把选择器当文件名的那一形。官方 npm 发行版也不设它 ——
   它只折 `PI_BUNDLED`。
   （**勘误**：本轮实测推翻了"设了它会丢掉 `execDir`"这条早期判断 ——
   `resolveLoaderCandidates` 的两条分支都并入 `baseReleaseCandidates`，随包 `.node`
   在两种情形下都命中；真正的问题是**用户目录排到了前面**。）
2. **`workerHostEntry()` 在新旧两种形态下都是 null**，这是入口不是 `cli.ts` 的固有代价，
   不是设哪个变量能补的：SDK 的 worker 子进程靠 `[executable, "__omp_worker_*"]` 重入
   自己的 CLI 入口，而我们不派发那些选择器。实测旧形态同一条路也一样失败
   （把选择器当参数喂给旧 exe，它照常报 `ready` 然后等 stdin）。**不是本轮引入的退化**，
   是既有缺口；浏览器 headless 与 relay 那两个闸门因此与官方 npm 版不同（都在 SDK 的
   `browser/registry` 里读 `isCompiledBinary() || workerHostEntry() !== null`）。

里程碑：`Bun.build({compile})` 全流程实测 **4.0 秒** —— 它不是慢步骤，
"去掉编译管线"的价值在**去掉一个 187 MB 的单文件产物与一圈 define/bytecode/embedded-addon
特例**，不在省时间。


### P2：agent-client 瘦身（已落地）

**做掉的（全仓零引用的死码，逐条文本核对过）：**

| 删掉的 | 原来在哪 |
|---|---|
| `DecodeError`、`EnvelopeError` | `error.rs` 两个零构造点的错误类型，导出只出现在 `lib.rs` 那一行 |
| `RunFrame::kind()` + 它专用的 7 个 `pub(crate) const` | `frame.rs` 的 `kind()` 表全仓 0 读者；判别式本就由 serde 的 `tag = "kind"` 产出 |
| `AgentClient::sessions()` 及其整条链 | `client.rs` + `Command::Sessions` + `lifecycle::entries_of`/`entry_of` + `SessionEntry` 导出。ADR 0055 与 `bridge.ts` 早已写明"本仓没有调用方" |
| `AgentClient::shutdown()` + `Command::Shutdown` + 驱动器那一支 | `client.rs` + `bridge.rs`。收据的唯一消费者是退出屏障，而那条路走的是 drop client → `commands_rx.next()` 返回 None（`bridge.rs:226`） |

`PROMPT_ADMITTED` 留着 —— 它有真读者（`conversation-runtime` 按它认准入帧）。

**没做的、以及为什么：**

- **29 个 `AgentClient` 方法体确实同形**（`oneshot` → `send` → 把通道被丢映射成 `Refused::Gone`），
  但那一句映射就是它们唯一的自有策略。删掉一个方法只是把 `Command::X` 的构造连同这句
  映射推给调用方，而 `commands` 是私有字段 —— 得把 `send` 一并外移。**这是重构不是瘦身**，
  收益是减一层，成本是动 29 处调用点，本轮不做。
- `read_media` / `abort_prompt` / `install_capability` 三条**恒返回 `Err(unwired(...))`**，
  但它们是**活的 IPC 面**（`agent_session_media` / `agent_abort_prompt` /
  `agent_capability_install`），删它们等于撤掉一条界面可见的错误契约（ADR 0052 后果第 5 条：
  不删入口）。要动得产品侧先同意，不属本 RFC 范围。
- **`recorder.rs` 的落账逻辑一行不动**（§4.3）。
- 整模块不可达的情况**一个都没有**：32 个 `.rs` 全都被声明且都有生产引用。

**顺带修的一处注释失锚**（AGENTS.md §6）：根 `Cargo.toml` 的 panic 纪律那段指的
`crates/agent-client/tests/recorder.rs` **不存在**（该目录只有 `bridge.rs` / `permission.rs` /
`secret_debug.rs` / `sessions.rs`），已改指真实存在的 `tests/sessions.rs`。

### P3：验证

- transcript 形状逐字不变（用 `packages/transcript` 的 schema 校验）。
- 取消不挂死：发 prompt 后立刻 cancel，UI 能收到 `turn_end` 且状态正确。
- 密钥不进前端 JS 堆：确认 `agent.db` 的读写不经过 Webview。
- `tauri build` 产物里没有 `poietica-agent*.exe`（**已通过**：`externalBin` 已删，`binaries/`
  里只剩 Bun 运行时、桥 bundle 与 `.node`）。
- 干净机器可启动：模拟空 `USERPROFILE`/`LOCALAPPDATA` 跑随包布局得 `ready` + `capabilities`
  （**已通过**，见 §5.4）。
- `bun run check` 全绿（Biome + 架构闸门 + 全工作区 typecheck/test + rustfmt + clippy
  `-D warnings` + `cargo test --workspace` + IPC 绑定一致性）。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Bun 运行时版本漂移导致行为不一致 | 运行时与 Poietica 版本锁死：随包发的就是**跑 `prepare-runtime.ts` 的那只 Bun**（`process.execPath`），用户机器上的 Bun 不参与 |
| `pi-natives` 的 `.node` 在某些平台缺预编译包 | 官方为 6 个平台都发预编译包（`loader-state.js:35-42` 的 `SUPPORTED_PLATFORMS`）；缺的平台在 `prepare-runtime.ts` 里当场报错，不静默降级 |
| 宿主环境里带 `PI_COMPILED`，让随包 `.node` 加载不到 | 档案的 `unsetEnv` 摘掉它（`packages/agent-catalog/src/omp/descriptor.ts`）；`isCompiledBinary()` 读的是运行时环境，只能这么拦 |
| 安装包变大（362 MB → ≈293 MB） | 实测是**变小**约 19%（§7-P1 的形态表）。收益是去掉编译管线与 187 MB 单文件产物，不是包大小 |
| 取消与超时不再有编译期兜底 | SDK 的 `session.cancel()` 是协作式的，bridge 用 `AbortController` 与超时 Promise 实现；Bun 进程本身由 `agent-client` 的 supervisor 重启 |
| 密钥意外进入前端 JS 堆 | `setApiKey` 等操作由 bridge 方法调 SDK 内部完成，前端不读取；`agent.db` 的读写不经过 Webview |
| 有人把 bridge import 进 Webview | §6 的分层规则 + `desktop-boundaries.ts` 拦；`src/index.ts` 不导出 `bridge.ts`，把 SDK 挡在出口清单之外 |
| 随包目录里少了一个文件，却在 PATH 上撞到同名程序 | 桥的入口只认随包目录（`beside_exe`），找不到当场报错；只有运行时允许 PATH 回落（那是给开发期留的） |

---

## 9. 验收标准

1. 打开一条旧会话，能回放完整 transcript。
2. 发一轮新对话，能收到增量 ops 与 `turn_end`。
3. 点「批准」能真的让下一次 write/exec 过闸。
4. 断网、取消、超时三种收尾，UI 不挂死。
5. `tauri build` 产物里没有 `poietica-agent*.exe`；Bun 运行时 + 桥 bundle + 原生模块按
   §7-P1 的体积入包。
6. `bun run check` 全绿。

---

## 10. 与 ADR 0052 的关系

本文**取代** ADR 0052 的"SDK 编进我们自己的二进制"决定，但**继承**它的核心洞察：

- 屏幕经过的产地必须在能看见 SDK typed event 的地方。
- 用户不装任何 CLI，只装 Poietica。
- omp 没有增量协议，增量由我们自己投影。

变的是：产地从"我们编的 exe"变成"随包分发的 Bun 运行时跑我们的桥 bundle"，而不是从"TS"变成"Rust"。

---

## 11. 拍板记录（2026-09）

**决策一：放弃"SDK 直接进 Webview"路线。** 官方"进程内集成"的"进程"是 Node/Bun 进程，不是 Webview 进程。实测证据（§0.1）证明：SDK 的 109 个 `node:fs` 文件（含 promises 224 个）、323 个 Bun API 文件以及 `pi-natives`（NAPI `.node`）全部依赖 Node/Bun 宿主 ABI；`engines` 只认 bun。把 SDK 塞进 Webview 不是集成，是为整个 SDK 重写运行时。否决。

**决策二：SDK 的宿主从"自有编译 exe"改为"随包分发的 Bun 运行时跑桥的 bundle"。** 这是**官方推荐方案**（官方 `docs/sdk.md` 写的是"from a Bun process"、"Requires Bun 1.3.14 or newer"，`examples/sdk/` 全是 `createAgentSession()` 跑在 Bun 里的模式）。不再用 `Bun.build({compile})` 编 187 MB 单文件，改为发一个与 Poietica 版本锁死的 Bun 运行时 + 桥的 bundle。理由：

- 官方设计的就是"在你的 Node/Bun 进程里 `createAgentSession()`"；我们用 Bun 运行时承载，正是官方推荐的进程内集成方式。
- 运行时与 Poietica 版本锁死，"用户机器上 Bun 版本漂移"不存在；
- 去掉编译步骤与 externalBin，CI/发版/调试都变简单；
- 桥代码改完即生效，不用重编 exe；
- `pi-natives` 的 `.node`、SDK 的 `node:fs`、`Bun.spawn` 全部原样可用，零移植成本。

**决策三：进程边界与一条 stdio 传输保留；桥变"库"而不是"没有进程"。** Webview 与 Bun 是两个 JS 引擎，bridge 进不了 Webview（决策一），所以两者之间必然有通道。删掉传输不会让边界消失，只会让边界没人守。

**决策四：`agent-client` 的落账逻辑留在 crate 里，不搬进 `src-tauri`。** 幂等、准入、投递不需要 `AppHandle`/`State`/`Emitter`，按 AGENTS.md §3「凡是不需要 AppHandle/State/Emitter 就能写出的逻辑，必须住在 crate 里并有自己的单测」，它属于 crate。`agent-client` 瘦身只删纯透传。

**决策五：不追官方的 RPC / ACP 模式。** 官方 RPC 命令面缺我们一半的命令（§4.4），追过去会变成两套协议并存。"按官方"落实在 SDK 用法上，不落实在传输协议上。

**决策六（本轮新增）：摘掉 `PI_COMPILED`，并把桥的入口钉在随包目录。** 前者见 §5.4 的实测：编译态分支会让随包 `.node` 不可达，而它读的是运行时环境。后者是「运行时可回落 PATH、入口不可」这条区分 —— 入口落到 PATH 上就是在跑另一个程序，"直接集成"也就无从谈起。
