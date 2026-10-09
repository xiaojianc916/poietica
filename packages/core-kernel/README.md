# @poietica/core-kernel

Core 进程的微内核：按 dependsOn 装配功能的 core 模块、给每个模块受限的 ctx、把契约方法绑定到处理器、
管理数据库迁移与引擎工具注册、按顺序调用生命周期钩子。内核不认识任何具体功能。

子入口：`.`（内核与类型）、`./events`（neutral 的事件令牌定义，供各功能 core-api 使用）、
`./testing`（`createCoreHarness`，功能 core 测试的统一入口）。

详见架构文档 06 页 §2。
