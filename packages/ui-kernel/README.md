# @poietica/ui-kernel

渲染进程的微内核：按 dependsOn 启动各功能的 ui、提供贡献点（界面 / 命令 / 快捷键 / 设置项 / 横幅……）、
提供内核服务（navigation、commands、keybindings、coreStatus、layout、toasts、dialogs、logging）、
以及连接 Host 的 Bridge 通道与 React 绑定（`KernelProvider`、`FeatureScope`、`useService`…）。

**不依赖 design-system**：内核不画任何界面；`FeatureErrorBoundary` 的兜底界面用最朴素的 HTML 加 `data-*`
属性，由 workbench 的样式表负责外观。运行时纯度由 tsconfig 的 dom 预设与 depcruise 的
`renderer-no-node-core` 规则保证。

详见架构文档 06 页 §5。
