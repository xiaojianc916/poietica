# 0030. Retain the DWM redirection surface

- Status: Accepted
- Date: 2026-08-26
- Owners: Desktop application composition root

## Context

Poietica 的主窗口由 Tauri、Wry 与 WebView2 组成。`additionalBrowserArgs` 曾同时强制启用
`RemoveRedirectionBitmap`、禁用 `CalculateNativeWinOcclusion`。前者在 Windows 11 22H2+
让 Chromium 给窗口加 `WS_EX_NOREDIRECTIONBITMAP`；DWM 因而没有可在隐藏或最小化恢复时
立即复用的上一帧。WebView2 的 DirectComposition surface 尚未提交时，只剩窗口衬底，
表现为整窗闪一下而不露出桌面。

关闭原生遮挡计算只能让隐藏的渲染器继续工作，不能重新造出被删除的 DWM redirection
surface；它增加后台资源消耗，却没有修复恢复时的合成缺口。

## Decision

- 显式禁用 `RemoveRedirectionBitmap`，让 DWM 保留最后提交的窗口表面。
- 不覆盖 `CalculateNativeWinOcclusion`，由 WebView2 运行时决定隐藏窗口的节流。
- `additionalBrowserArgs` 只显式保留 Wry 的三个默认禁用项和产品所需的
  `msWebView2EnableDraggableRegions`。
- `window-surface-policy` 在架构检查中守住原生、启动、应用根与浏览器参数。

## Consequences

- 隐藏或最小化恢复时，DWM 能立即复用上一帧；React 不参与窗口恢复。
- 后台渲染恢复 WebView2 默认节流，运行中的原生 agent 不受影响。
- Windows 11 会多保留一份 DWM redirection bitmap；稳定呈现优先于这部分显存。

## Rejected

- `visibilitychange`、强制 React 重渲、`requestAnimationFrame` 重绘或延迟 `show()`：
  都位于 WebView 内容层，无法补回 DWM 缺失的表面。
- 继续禁用原生遮挡计算：只改变后台调度，不改变恢复时可用的合成表面。

## Evidence

- Microsoft, Extended Window Styles: `WS_EX_NOREDIRECTIONBITMAP` 不渲染到 redirection surface。
  https://learn.microsoft.com/windows/win32/winmsg/extended-window-styles
- Chromium `components/viz/common/features.cc`: 该特性删除 redirection bitmap；内容到位前
  以 acrylic/backdrop 占位。
- Chromium `ui/views/widget/widget_hwnd_utils.cc`: 启用时直接添加
  `WS_EX_NOREDIRECTIONBITMAP`。
- Tauri/Wry `additional_browser_args`: 自定义值替换 Wry 默认 browser arguments。
