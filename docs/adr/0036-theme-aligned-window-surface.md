# 0036. Theme-aligned window surface

- Status: Accepted
- Date: 2026-09-03
- Owners: Desktop application composition root

## Context

主窗口是不透明窗口，但运行期有三层可见表面：原生 Window、WebView2 默认背景和 HTML document。
旧实现只把 document 切到深色，Window/WebView backing 始终固定为 `#f3f3f3`。最小化或隐藏后恢复时，
DWM 与 WebView2 内容 surface 重新合成；若 backing 先于内容帧可见，深色界面就短暂露出浅色底。

Tauri `WebviewWindow.setBackgroundColor` 同时更新 Window 与 WebView；Windows 下 Wry 将 WebView 颜色
写入 WebView2 `DefaultBackgroundColor`。该 API 的公开目的包括避免 WebView 加载时的白闪。

## Decision

1. `SettingsStore` 是主题偏好的唯一持有者；设置草稿只把预览意图发给应用组合根。
2. `ThemeRuntime` 是唯一主题写入口，解析 `system` 后同步 document、Window 与 WebView 三层。
3. 启动先读取设置并完成首轮三层同步，再提交 React 首帧并呈现窗口。
4. 系统主题监听归 `ThemeRuntime` 所有，偏好改变时替换，运行时销毁时释放。
5. 原生颜色更新串行执行，快速切换不能让旧异步结果覆盖新主题。
6. 使用 Tauri 官方 API；不新增 Win32 hook、自定义 IPC 或第二套窗口状态。
7. 创建期浅色 fallback 与预运行 light/dark 副本由 `window-surface-policy` 对运行时正本做一致性检查。

## Data flow

`SettingsStore / SettingsSession draft → ThemeRuntime → resolved theme → document + Tauri WebviewWindow`

偏好只有 SettingsStore 一份真相；resolved theme 是 ThemeRuntime 的瞬时投影，不落盘、不回灌设置。

## Consequences

- 深浅色启动、恢复、托盘唤醒及系统主题切换都显示当前主题的 backing，而不是固定浅色。
- 设置页仍即时预览，不等待防抖保存。
- 原生同步失败进入统一失败管线；文档主题仍可使用，应用不被错误升级为致命失败。
- ADR 0030 的 DWM redirection surface 策略继续保留；它缩小内容缺帧窗口，本决策保证缺帧时底色正确。

## Evidence

- Tauri `WebviewWindow.setBackgroundColor`: https://github.com/tauri-apps/tauri
- Wry WebView2 `SetDefaultBackgroundColor`: https://github.com/tauri-apps/wry
- WebView2 restore blank-surface report: https://github.com/MicrosoftEdge/WebView2Feedback/issues/5171
- WebView2 default-background rationale: https://github.com/MicrosoftEdge/WebView2Feedback/issues/414
- Tauri native/webview flash analysis: https://github.com/tauri-apps/tauri/issues/1564
- VS Code keeps BrowserWindow background synchronized with theme:
  https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/electron-main/themeMainServiceImpl.ts
