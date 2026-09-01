# Shared composer surface

**我是什么**：`@poietica/surfaces` 内部的 composer 表现能力。

**我拥有什么**：输入框框体、量度、会话配置控件及其样式。

**谁允许调用我**：同包内需要 composer 的领域表面，例如 `conversation/` 与 `automation/`。

**我不许知道什么**：自动化草稿、对话转录、IPC、持久化与执行生命周期；状态仍归调用方。
