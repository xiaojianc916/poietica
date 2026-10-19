# @poietica/feature-intelligent-ui

对话内智能界面（原审查 R-18 的 `show_widget`，重构后改名 `intelligent_ui`）：agent 现写一段 HTML，在对话里渲染成可交互的界面；界面能把用户的选择写成**状态**、登记几组「调整」控件，下一句话时交给模型。

- `contract`：三个进程共用的常量（外壳地址、CDN 白名单、随包库清单、设计令牌名、各项上限），状态的两条 RPC（`intelligentUi.getState` / `intelligentUi.setState`，Core），以及要碰窗口与文件的两条（`intelligentUi.copyImage` / `intelligentUi.exportHtml`，Host）。
- `core`：注册 agent 工具 `intelligent_ui`（参数校验；声明 `streamInput`，参数边写边推给卡片）与 `intelligent_ui_guide`（按需取设计与桥接指南，长文不再每轮都进系统提示）；状态表 `intelligent_ui_states`（model / view / tweaks 三份）；向 conversation 的 `TurnContextRegistry` 登记，把「上次交给模型之后变过的状态」随下一句交出去（那句话没送到就退回未交出）；线程删除时清账。
- `host`：资源协议 `poietica-asset://intelligent-ui/` 下的外壳文档与 CSP、随包库（`vendor/`：d3、Chart.js、Lucide 的 UMD 文件，构建时 `?raw` 读入）；截图进剪贴板；导出独立 HTML 文件（同一份外壳脚本 + 内嵌用到的随包库）。
- `ui`：往 conversation 的 `toolCallRenderers` 贡献卡片（`inline: true`）。参数还在流时先画预览（外壳不跑脚本），定了在同一个 iframe 里换成真界面；悬停工具条：调整、复制为图片、导出 HTML、展开。外壳与卡片之间只走一条私有 `MessageChannel`；send / draft / open 要外壳证明「用户刚刚在这个界面里动过手」，没有就改成确认条。

不再支持 `url` 来源（嵌入本机开发服务器）：要看用户自己的项目，用内置浏览器（`browser.open`）。主窗口 CSP 的 `frame-src` 随之只剩外壳。

`intelligentUi.getState` 对已删除线程返回 `null` 是刻意的：卡片卸载/线程删除之后仍要能读回一次（读到就是 `null`，读者把它们当成没写过），行会随 `threadRemoved` 清掉。只有 `setState` 校验线程并抛 `thread_not_found` —— 往已删线程里写只会留一行永远没人清的孤账。

随包库的许可：d3（ISC）、Chart.js（MIT）、Lucide（ISC），版本见 `contract` 的 `INTELLIGENT_UI_LIBRARIES`（与本包 `package.json` 一致，有单测钉住）。

功能分级 4（插件）：依赖 conversation（`core-api` / `ui-api`）与 platform（`contract`），conversation 不认识它。
