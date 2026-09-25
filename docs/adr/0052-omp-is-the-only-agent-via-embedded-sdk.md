# 0052 — omp 是唯一的 agent，SDK 编进我们自己的二进制

## 状态

已接受。取代 0026（kap 是唯一的 agent 传输）。0008/0009/0016/0021/0022/0024/0025
的传输前提一并作废。

## 决定

Poietica 唯一的 agent 是 oh-my-pi（omp，`@oh-my-pi/pi-coding-agent`，MIT，
锚定 18.3.0）。接入方式是**把 omp 的 SDK 编进我们自己产出的一个可执行文件**，
Rust 侧以 `--mode rpc`（stdio NDJSON）驱动它。用户不装任何 CLI，只装 Poietica。

三件事同时成立，缺一条这个决定就不成立：

1. **SDK 可以脱离用户环境被编成单文件。** 实测（2026-09-23，win32-x64，Bun 1.4.2）：
   `Bun.build({ compile: { outfile } })` 把我们的入口连 SDK 一起编成 187 MB 的
   `omp-embed.exe`，无 node_modules、无用户安装的 omp、无 Bun，直接跑通。
2. **编出来的二进制支持 RPC 模式。** 同一份产物 `--mode rpc` 与源码版行为一致
   （ready 帧、`negotiate_protocol` v2、`get_state` 等实测均通）。
3. **入口是我们自己的。** 这给了屏幕经过的产地：SDK 的 `session.subscribe` 是
   typed event，transcript 的翻译必须住在能看见那些类型的地方，也就是这个入口里。

## 为什么不是另外两条路

**不接 ACP。** 0026 已经把 ACP 删过一次，理由今天仍然成立：ACP 只交付已提交的
assistant 文本，没有流式、没有工具活动、没有增量。omp 的 ACP 也一样。

**不下载官方 omp 单文件当外部程序。** 那样确实也不用用户装 CLI，但屏幕经过只能
在 Rust 里手写事件判别——把一份协议知识放进通用层，且没有类型兜底。SDK 编进来的
路让翻译住在 TS 侧、贴着 typed event，Rust 只搬字节。

**不在 Tauri 进程内跑 SDK。** 组合根是 Rust。SDK 要 Bun。跨语言同进程只有嵌一个
JS 运行时这一条路，那会在 `crates/` 之外立起第二个组合根，撞 §5「同款逻辑第二份
出现即为缺陷」。子进程 + stdio 把这条边界留在进程边界上，崩溃也不互染。

## 屏幕经过怎么产

omp 没有 kap 那样的 `subscribe_v2` 增量协议，也没有 REST 追赶。它有的是
`session.subscribe` 的 typed event 与 `get_entries` / `get_messages_page` 的历史。
所以**增量协议由我们自己的入口产出**：入口订阅 SDK 事件，投影成
`packages/transcript` 已经钉住的 `transcript.ops` / `transcript.reset` 形状，
经同一条 stdout 交给 Rust。

契约不变：`packages/transcript/src/contract/schema.ts` 仍是线上形状的唯一定义，
校验仍在 native-bridge 的 transcript 端口。变的是产地，不是形状。

## 后果

1. `crates/kap-client` 换成 `crates/agent-client`：REST + WebSocket + 生成模型
   （`generated/`、`http.rs`、`connection/`、`session/rest.rs`、`model_catalog.rs`、
   `process/instance_registry.rs`）整套删除，换成 NDJSON stdio 的收发与命令应答
   配对。`frame.rs`、`recorder.rs`、`run_slot.rs`、`interaction/` 与下游一律不动。
2. `contracts/kap/` 与 `tools/contract/kap-*.ts` 删除：omp 的 RPC 契约由
   `docs/rpc.md` 与 `rpc-types.ts` 自述，没有 `/openapi.json` 可钉。**这是本决定
   唯一接受的退步**：协议漂移不再有 `kap:spec:check` 先告诉你，只能靠升级时重跑
   测试发现。omp 版本因此锁死（`package.json` 精确版本，无 `^`）。
3. 受控 home 从 `KIMI_CODE_HOME` 换成 `PI_CODING_AGENT_DIR`（omp 的绝对 agent 目录
   覆盖；`PI_CONFIG_DIR` 只是 home 下的目录名，不是路径，不用它）。
4. omp 首次运行会去读用户磁盘上的 `.claude`/`.codex`/`.gemini`/`.github` 等
   （README「Discovery」一节明说）。这与升级无关，同一版本在不同机器上行为不同，
   必须显式关掉：受控 home 的 config 里 `disabledProviders` 逐项列全。
5. 界面一个控件都不删。`permission`、`questions`、`model catalog`、`capability`、
   `mcp`、`skills`、`fork`、`archive` 这些面在新 agent 下可能一时没有后端，界面
   照旧渲染，由档案能力位决定置灰，不删入口。
6. 体积：随包多约 190 MB（单文件，已含 Bun 运行时与平台 `.node`）。用户已明确接受。

## 待验证（动工前必须补的证据）

- 一次真实模型轮次的事件流形状（当前只验到无凭据下的握手与状态帧）。
- 工具授权在 RPC 上走 `extension_ui_request` 的哪一条（`confirm`？），以及
  `tools.approvalMode` 与它的关系。
- 编出来的二进制在 macOS/Linux 上的同款行为（本机只验了 win32-x64）。
