# ADR-007：omp Runtime 外置与 ARP

## 状态

实施中（P3 第一批：ARP 握手与 Worker 通用外壳）

## 决定

- Core 与 omp Runtime Worker 之间用 **ARP**：stdio 上的 JSON-RPC 2.0，沿用 `rpc` 包分帧。
- ARP 只因为进程边界存在（故障隔离、沙箱），不做引擎抽象；方法形状贴着 omp 会话 API，参数用 omp 公开类型。
- 方向：Core 是客户端，Worker 是服务端；Worker 可反向请求策略、提问、产品工具与凭据。
- 版本号只用于检测半更新：不一致就重启 Worker，不做能力协商、不做第三方兼容。
- 未知事件不丢：Worker 以 `notice` 通用事件透传原始内容。

## 已落地

- `packages/runtime-protocol/src/arp.ts`：`ARP_VERSION`、`runtime.hello` / `runtime.ping` / `runtime.shutdown`、握手 schema 与错误码。
- `packages/runtime-kernel`：通用 Worker 外壳，负责传输、握手、方法查表、关停；不 import 任何引擎类型。
- ARP 会话/Run 第一批 schema：`session.open` / `session.page` / `run.submit`，参数形状与 `OpenSessionSpec`、`SubmitInput` 对齐。
- `packages/runtime-manager`：`RuntimeProcess` 起子进程、建 stdio 传输、ARP 握手、转发请求、停止/退出检测；测试用真实子进程验证握手、注入方法与崩溃标记 failed。
- `packages/engine-omp/src/arp`：`createArpHandlers` 把 `session.open/page/close`、`run.submit/cancel` 映射到 AgentEngine；`createOmpRuntimeWorker` 把引擎装成 ARP Worker。测试用 FakeEngine 走通 kernel → ARP → engine。
- `poietica-core.exe runtime --data-root <路径>`：独立进程建 omp 引擎并挂 ARP；`bun run core:runtime-probe` 真实拉起该进程，完成 hello / session.open / session.page / session.close。
- Core 默认启用 ARP Runtime；`POIETICA_RUNTIME_ARP=0` 可退回进程内 engine。
- `bun run core:kill-probe`：强杀 runtime 子进程后 Core 存活，Worker 自动重启并恢复 ArpSession，Thread 可继续冷读（约 2 秒）。
- Worker 方法由各 Worker 注入 handlers，能力表写进 hello 结果。

## 待落地

- `apps/runtime` omp Worker：把 `engine-omp` 整体移入 Worker，Core 侧只留 omp-types 与 ARP 客户端。
- Runtime Manager：`RuntimePool` 已做工作树键复用与失败重建；`RuntimeProcess` 已做崩溃退避重启（默认关闭，由上层开启）。心跳、非终态 Run 记 `run.interrupted`、待送文件补收仍待做。
- 产品工具经 ARP 下发并注册为 omp 自定义工具。
- 混沌测试：杀 Worker 后其余工作区不受影响，对应 Thread 可继续。
