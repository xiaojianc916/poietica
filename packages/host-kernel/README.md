# @poietica/host-kernel

Electron 主进程的微内核：应用身份与单实例、窗口与安全基线、Core 进程的启动与监管（CoreSupervisor）、
渲染进程 ↔ Host ↔ Core 的 RPC 路由（RpcHub）、`poietica-asset://` 协议、退出协调。
与 core-kernel 一样，它不认识任何具体功能——功能的 host 模块只实现自己的方法。

可测试性：`rpc-hub.ts`、`core-supervisor.ts`、`asset-protocol.ts` 不在模块顶层 import electron，
需要的 Electron 能力由构造参数注入，因此能在 bun test 中运行。

详见架构文档 06 页 §4。
