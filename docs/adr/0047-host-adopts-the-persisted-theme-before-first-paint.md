# 0047. The host adopts the persisted theme before the first paint

- Status: Accepted
- Date: 2026-09-20
- Owners: Desktop application composition root

## Context

ADR 0036 决策 3 要求"启动先读取设置并完成首轮三层同步，再提交 React 首帧并呈现窗口"，
但落地的只有渲染层这一条路：`mount.tsx` 等 `runtime.settings.load()` 拿到偏好，
再调 `runtime.theme.setPreference(theme)`，`WindowSurface` 在那之前一直是 `None`。

于是窗口从创建到渲染层投影之间有一段谁都没管的窗口期，而它恰好是窗口最可能被看见的
时候：

- 窗口以 `visible: false` 创建，呈现由 `mainWindow.present()` 触发；原生 setup 与前端
  就绪之间有真实耗时（`native setup finished` 实测 573–2081 ms），前端可能赶不上。
- `present_watchdog` 8 秒兜底直接 `activate()` 呈现窗口，此时渲染层可能一个字节都还没投影。
- `activate()` 里的 `reapply()` 在 `None` 状态下是空操作 —— 兜底路径等于没设衬底。

这期间露出的颜色由三件事各自决定，且都不看应用偏好：

| 层 | 窗口期的值 | 依据 |
| --- | --- | --- |
| 原生窗口 | `#f3f3f3` | `tauri.conf.json` 的 `backgroundColor` |
| WebView2 | `#f3f3f3` | 同上，创建期成对设置 |
| document | `#f3f3f3` | `index.html` 的预运行初稿 |

document 那层还有第二个分叉：它的 `@media (prefers-color-scheme: dark)` 覆盖读的是
WebView2 的 preferred color scheme，而创建期它是从 `window.theme()` 推出来的
（`tauri-runtime-wry` 的 `with_theme`），`window.theme()` 在没钉过主题时读系统 ——
**系统与应用偏好是两件事**。用户偏好深色而 Windows 为浅色时，页面自己刷成浅色。

症状因此是"深色模式下启动闪一下浅色底"，且只在启动时出现：渲染层投影一旦落地，
三层就都对了。

## Decision

1. 原生 `setup` 在窗口被看见之前读一次持久化偏好，按它落定衬底与原生主题；
   入口是 `WindowSurface::adopt`，与运行期同一条写入路径。
2. `adopt` 同时 `Window::set_theme`。衬底颜色与原生主题是一件事的两半：不钉主题，
   document 层的预运行初稿就继续跟系统走。
3. 偏好 → 主题的映射只在这里做一次：`Light`/`Dark` 给 `Some(Theme)`，`System` 给
   `None`（跟随系统，与 `Window::set_theme` 同义）。落定后**回读** `window.theme()`
   再选色，高对比度之类的例外由 tao 裁决，宿主不重算。
4. 读设置失败不拦启动：衬底退回创建值，渲染层投影照旧接管，只记一条 warn。
5. 两份衬底色（`LIGHT_SURFACE`/`DARK_SURFACE`）成为第四份抄本，
   `window-surface-policy` 与调色板正本逐通道核对。
6. `adopt` 是启动落定，`set` 是运行期投影，两者共用 `apply`；不新增第二套写路径。

## Consequences

- 深色偏好下窗口从第一帧起就是深色衬底，呈现看门狗兜底与拖拽露出的都是它。
- 偏好为 `System` 时行为不变：主题与衬底都跟随系统。
- 三层颜色仍由 `WindowSurface` 单一持有；渲染层投影到达后覆盖启动落定值，无冲突。
- 改衬底色从"调色板一格 + 三份抄本"变成"调色板一格 + 四份抄本"，
  `bun run test:architecture` 漏改哪一份就指名报出。
- ADR 0036 的三层同步机制、宿主所有权、`activate()` 重应用入口均不变；
  本决策补上它决策 3 里宿主那一半。

## Evidence

- 创建期两层都取 `tauri.conf.json` 的 `backgroundColor`：
  `tauri-2.11.5/src/webview/webview_window.rs` 的 `from_config`。
- 创建期 WebView2 的 color scheme 取自 `window.theme()`：
  `tauri-runtime-wry-2.11.4/src/lib.rs`（`webview_builder.with_theme(match window.theme() ...)`）。
- 运行期 `set_theme` 经 `WindowMessage::SetTheme` → tao `set_theme` → `CHANGE_THEME_MSG_ID`
  → `update_theme` → `WindowEvent::ThemeChanged` → `webview.set_theme` →
  `ICoreWebView2_13::Profile().SetPreferredColorScheme`，即 document 的
  `prefers-color-scheme`（`tao-0.35.3/src/platform_impl/windows/{window,event_loop,dark_mode}.rs`、
  `wry-0.55.1/src/webview2/mod.rs`）。
- `Window::theme()` 是同步 getter：`send_user_message` 在主线程上就地执行
  （`tauri-runtime-wry-2.11.4/src/lib.rs`），setup 正在主线程，故 `adopt` 无竞态、不死锁。
- 现场证据：`poietica.log` 中 `frontend did not present within 8s; showing the window anyway`
  在多次启动里出现 —— 兜底呈现窗口时渲染层尚未投影，`reapply()` 是空操作。
- 同一份日志里 `main webview not found` 零次，两层成对设置这一条没有回归。
- 判据在 `tools/architecture/charters.ts` 的 `themeSurfaceIsAligned`：新增
  `adopt`、`window.set_theme(`、组合根调用点三处探针与第四份抄本的逐通道核对，
  三条都做过反例验证（改色、摘掉调用、去掉钉主题各自报错）。
