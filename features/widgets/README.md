# @poietica/feature-widgets

对话内组件（审查 R-18 的 `show_widget`）：agent 现写一段 HTML（或给一个本机开发服务器地址），在对话里渲染成可交互的组件。

- `contract`：三个进程共用的常量（外壳地址、CDN 白名单、设计令牌名、html 上限）。没有 RPC 方法，不进 `protocol`。
- `core`：注册 agent 工具 `show_widget`（参数校验、url 探活）。
- `host`：资源协议 `poietica-asset://widget/` 下的外壳文档与 CSP。
- `ui`：往 conversation 的 `toolCallRenderers` 贡献卡片（`inline: true`），send / draft 经 `ConversationUiToken`。

功能分级 4（插件）：依赖 conversation（`ui-api`）与 platform（`contract`），conversation 不认识它。
