# 0007. Theme-aligned window surface

- Status: Accepted（实现细节由 [0011](0011-window-surface-reads-shell-chrome.md)、
  [0012](0012-host-adopts-the-persisted-theme-before-first-paint.md) 与
  [0028](0028-electron-with-napi-is-the-desktop-host.md) 更新）
- Date: 2026-09-03
- Owners: Desktop application composition root

## Context

主窗口是不透明的，而窗口期与恢复期露出的底是**宿主**拥有的表面，不是 document。
只把 document 切到深色，宿主 backing 就仍是固定浅色：最小化或隐藏后恢复时，
合成器与内容 surface 重新合成，若 backing 先于内容帧可见，深色界面就短暂露出浅色底。

三层表面是当时的形态（原生 Window / WebView backing / HTML document）。ADR 0028 之后
宿主只剩一层可控表面（`BrowserWindow` 的底色），三层收敛成两层 —— 但**判据不变**：
宿主先记录期望色，再落定；渲染层只提交意图。

## Decision

1. `SettingsStore` 是主题偏好的唯一持有者；设置草稿只把预览意图发给应用组合根。
2. `ThemeRuntime` 解析 `system` 并同步 document；宿主侧的窗口底色是它的唯一投影。
3. 启动先读取设置并完成首轮同步，再提交 React 首帧并呈现窗口。
4. 系统主题监听归 `ThemeRuntime` 所有，偏好改变时替换，运行时销毁时释放。
5. renderer 只提交一条生成命令；宿主先记录期望色，再落定窗口底色与 `nativeTheme.themeSource`。
6. `activate()` 在 unminimize/show/focus 前重应用宿主状态；不新增平台 hook、timeout 或重绘技巧。
7. 创建期浅色 fallback、预运行颜色、宿主所有权和恢复入口由 `window-surface-policy` 持续校验。

## Data flow

`SettingsStore / SettingsSession draft → ThemeRuntime → document + generated IPC → 宿主窗口底色`

偏好只有 SettingsStore 一份真相；resolved theme 是 ThemeRuntime 的瞬时投影，不落盘、不回灌设置。

## Consequences

- 深浅色启动、恢复、托盘唤醒及系统主题切换都显示当前主题的 backing，而不是固定浅色。
- 设置页仍即时预览，不等待防抖保存。
- 宿主同步失败进入统一失败管线；宿主仍记住期望色，并在下次 activation 重试。
- 创建期只有一个探针点（`electron/main.ts` 的 `backgroundColor`），两条同步路径收敛成一条。

## Evidence

- Electron `BrowserWindow` 的 `backgroundColor` 与 `setBackgroundColor`：
  https://www.electronjs.org/docs/latest/api/browser-window
- `nativeTheme.themeSource` 同时决定窗口主题与渲染进程的 `prefers-color-scheme`：
  https://www.electronjs.org/docs/latest/api/native-theme
- VS Code 让 `BrowserWindow` 底色跟随主题（同一做法的先例）：
  https://github.com/microsoft/vscode/blob/main/src/vs/platform/theme/electron-main/themeMainServiceImpl.ts
