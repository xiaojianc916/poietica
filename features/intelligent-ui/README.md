# @poietica/feature-intelligent-ui

对话内智能界面（原审查 R-18 的 `show_widget`，本次重构改名 `intelligent_ui`）：agent 现写一段 HTML（或给一个本机开发服务器地址），在对话里渲染成可交互的界面；界面能把用户的选择写成**状态**，下一句话时交给模型。

- `contract`：三个进程共用的常量（外壳地址、CDN 白名单、设计令牌名、各项上限），以及状态的两条 RPC（`intelligentUi.getState` / `intelligentUi.setState`）。
- `core`：注册 agent 工具 `intelligent_ui`（参数校验、url 探活）与 `intelligent_ui_guide`（按需取设计与桥接指南，长文不再每轮都进系统提示）；状态表 `intelligent_ui_states`；向 conversation 的 `TurnContextRegistry` 登记，把「上次交给模型之后变过的状态」随下一句交出去；线程删除时清账。
- `host`：资源协议 `poietica-asset://intelligent-ui/` 下的外壳文档与 CSP。
- `ui`：往 conversation 的 `toolCallRenderers` 贡献卡片（`inline: true`）。外壳与卡片之间只走一条私有 `MessageChannel`；send / draft / open 要外壳证明「用户刚刚在这个界面里动过手」，没有就改成确认条。

功能分级 4（插件）：依赖 conversation（`core-api` / `ui-api`）与 platform（`contract`），conversation 不认识它。
