# @poietica/design-system

设计系统：CSS 变量（tokens/）、基础控件、图标与标记、主题控制器。样式变量一个都不改——
后面所有界面与 legacy 截图对照，都依赖这些变量保持一致。

从 legacy `packages/design-system/**` 原样迁移（删除了 CHARTER.md）；导出清单经过审查：
legacy 全仓没有任何使用处的导出已删除，有使用的保留且接口不变。

另外收**不认识业务、被两个以上功能共用的富界面**（Markdown 正文 `./prose`、分支 / 工作区选择器）：
不调 RPC、不持有功能 store、不 import 任何功能的 `contract`。判据见 `docs/ARCHITECTURE.md` §4.3。

| 入口 | 内容 | 重依赖 |
| --- | --- | --- |
| `.` | 令牌、控件、标记、选择器 | base-ui |
| `./diff` | 统一 diff 的解析与着色 | shiki |
| `./prose` | Markdown 正文（流式波浪、数学、mermaid 图、表格导出） | streamdown、katex、pele |

详见架构文档 13 页 §4。
