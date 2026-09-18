# Shared composer surface

**我是什么**：独立包 `@poietica/conversation/composer`，对话与自动化两个 composer 共用的表现能力。

**我拥有什么**：输入框框体、上下文栏（`.composer-context`）、量度、会话配置控件及其样式。

**谁允许调用我**：需要 composer 的领域表面——`@poietica/conversation/surface` 的 conversation/ 与 `@poietica/automation` 的 ui/。

**组装好的那张卡走 surface 入口**：`AssistantComposer`（`@poietica/conversation/surface`）自带提问面板与审批带，那两样是对话的概念，所以它归 surface 而不是归这里；自动化编辑器借用的就是它，外加上面这几样共用件。

**我不许知道什么**：自动化草稿、对话转录、IPC、持久化与执行生命周期；状态仍归调用方。
