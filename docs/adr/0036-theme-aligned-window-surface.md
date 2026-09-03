# 0036. Theme-aligned window surface

- Status: Accepted
- Date: 2026-09-03
- Owners: Desktop application composition root

## Context

主窗口是不透明窗口，但运行期有三层可见表面：原生 Window、WebView2 默认背景和 HTML document。
旧实现只把 document 切到深色，Window/WebView backing 始终固定为 `#f3f3f3`。最小化或隐藏后恢复时，
DWM 与 WebView2 内容 surface 重新合成；若 backing 先于内容帧可见，深色界面就短暂露出浅色底。

Tauri 的 JS `WebviewWindow.setBackgroundColor` 顺序提交 Window 与 WebView 两条 IPC；Rust 宿主的
`WebviewWindow::set_background_color` 则是应用可用的最小官方边界。Windows 下 Wry 最终把 WebView
颜色写入 WebView2 `DefaultBackgroundColor`。

## Decision

1. `SettingsStore` 是主题偏好的唯一持有者；设置草稿只把预览意图发给应用组合根。
2. `ThemeRuntime` 解析 `system` 并同步 document；`HostWindowSurface` 唯一持有 Window/WebView 的 resolved RGB 投影。
3. 启动先读取设置并完成首轮三层同步，再提交 React 首帧并呈现窗口。
4. 系统主题监听归 `ThemeRuntime` 所有，偏好改变时替换，运行时销毁时释放。
5. renderer 只提交一条生成命令；宿主先记录期望色，再用 Tauri 官方 API 同步 Window 与 WebView。
6. `activate()` 在 unminimize/show/focus 前重应用宿主状态；不新增 Win32 hook、timeout 或重绘技巧。
7. 创建期浅色 fallback、预运行颜色、宿主所有权和恢复入口由 `window-surface-policy` 持续校验。

## Data flow

`SettingsStore / SettingsSession draft → ThemeRuntime → document + generated IPC → HostWindowSurface → Window + WebView`

偏好只有 SettingsStore 一份真相；resolved theme 是 ThemeRuntime 的瞬时投影，不落盘、不回灌设置。

## Consequences

- 深浅色启动、恢复、托盘唤醒及系统主题切换都显示当前主题的 backing，而不是固定浅色。
- 设置页仍即时预览，不等待防抖保存。
- 原生同步失败进入统一失败管线；宿主仍记住期望色，并在下次 activation 重试。
- ADR 0030 的 DWM redirection surface 策略继续保留；它缩小内容缺帧窗口，本决策保证缺帧时底色正确。

## Evidence

- Tauri `WebviewWindow.setBackgroundColor`: https://github.com/tauri-apps/tauri
- Wry WebView2 `SetDefaultBackgroundColor`: https://github.com/tauri-apps/wry
- WebView2 restore blank-surface report: https://github.com/MicrosoftEdge/WebView2Feedback/issues/5171
- WebView2 default-background rationale: https://github.com/MicrosoftEdge/WebView2Feedback/issues/414
- Tauri native/webview flash analysis: https://github.com/tauri-apps/tauri/issues/1564
- VS Code keeps BrowserWindow background synchronized with theme:
  https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/electron-main/themeMainServiceImpl.ts
