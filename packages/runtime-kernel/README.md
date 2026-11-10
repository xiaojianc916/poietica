# @poietica/runtime-kernel

（一句话说明职责；见架构文档 03 页 §2.2。）

当前提供 ARP 握手（`runtime.hello` / `runtime.ping` / `runtime.shutdown`）与通用方法查表；omp 会话/Run 方法由后续的 `apps/runtime` 注入。
