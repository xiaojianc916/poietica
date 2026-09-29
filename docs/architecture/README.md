# Architecture Overview

架构宪法在 `agents.md`。这里只放**跨包边界的执行事实**与**文档索引**，不重抄宪法。

## Dependencies

`tools/architecture/layering.ts` 声明层组与允许的 peer-domain 边。manifest 与
source 两侧检查都读它。未声明的 peer 边一律禁止。跨包只走 exports；同域实现
走相对模块路径。

运行时文件图拒绝环与不透明加载，并透传 headless 入口。类型-only 边不构成
运行时环，但仍受包方向约束。包内目录环与 crate 内模块环同样拒绝， façade
藏不住互依赖。crate 目录来自 cargo metadata，不来自 crate 名。Conversation
core 额外拒绝向上的知识依赖与含类型-only 边的环。原生集成消费域的 headless
入口，包括编译器解析的别名。

## Composition and contracts

Desktop entry 组装、启动、释放应用 owner。模型策略、附件接收、浏览器集成、
窗口策略留在各自能力里。现有的原生 conversation runtime 拥有执行租约与恢复。
Rust IPC 类型与共享命令面生成 renderer 绑定。**没有第二个协议 reducer、事件
总线或兼容入口。**

## Verification

`bun run check` 验类型、测试、架构、Rust 与生成契约漂移。前端生产构建额外验
样式搬迁与资源导入。原生重连、取消与关机行为需要应用级测试。ADR 保留历史
决策；本总览与可执行策略描述当前结构。

## 索引

- [UI authority](./ui-authority-boundaries.md)
- [Layer ownership](./layer-ownership.md)
- [Window lifecycle](./window-lifecycle.md)
- [Agent client](./agent-client.md)
- [Data layout](./data-layout.md)
- [Embedded browser](./embedded-browser.md)
- [Agent activity feed](./agent-activity-feed.md)
