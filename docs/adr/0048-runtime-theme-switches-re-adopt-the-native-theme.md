# 0048. Runtime theme switches re-adopt the native theme

- Status: Accepted
- Date: 2026-09-20
- Owners: Desktop application composition root

## Context

ADR 0047 决策 2 定下「衬底颜色与原生主题是一件事的两半」，但只落实了启动那一半：
`composition.rs` 在窗口被看见之前调一次 `WindowSurface::adopt`，按持久化偏好
`set_theme`。运行期改偏好走的是另一条路 —— `theme-runtime.ts` 只调
`window_set_surface` 换衬底色，**原生主题停在启动那一档**。

于是「跟随系统」在运行期是坏的，而症状与直觉相反：

1. 偏好为 `dark` 启动，`set_theme(Some(Dark))` 把原生主题钉死；
2. 这一钉同时决定 WebView2 的 preferred color scheme（ADR 0047 的 Evidence 已记
   这条链路），即文档层的 `prefers-color-scheme` 变成 dark；
3. 用户切到「跟随系统」，渲染层 `applyThemePreference('system')` 就地读
   `matchMedia('(prefers-color-scheme: dark)')` —— 读到的是第 2 步钉住的那一层，
   于是解出 `dark`；
4. 全仓没有任何路径在运行期调 `set_theme(None)`，闩锁再没被解开。

**系统是浅色，界面却是深色** —— 因为渲染层问的「系统」根本不是系统，是上一个偏好。

反过来的方向同样错：偏好为 `light` 启动再切「跟随系统」，在深色系统上会解出浅色。

## Decision

1. 新增 IPC `window_set_theme(preference) -> ResolvedTheme`，运行期改偏好时由宿主
   落定原生主题。它与启动落定共用 `WindowSurface::adopt`，不新增第二套写路径。
2. **解析归宿主**：命令回读 `window.theme()` 并把结果交回渲染层，渲染层不自己读
   `prefers-color-scheme` 作首解。理由是顺序 —— 渲染层先读、宿主后钉，读到的必然是
   上一个偏好，这正是本缺陷的成因。系统此后再变仍由 `matchMedia` 的 change 事件报。
3. 偏好 → 原生主题的映射收敛到 `WindowSurface::native_theme` 一处：`Light`/`Dark` 给
   `Some(Theme)`，`System` 给 `None`。启动与运行期共用，两份映射迟早分叉。
4. `setPreference` 由同步改为 async：它现在要等宿主答完再投影。代际计数照旧，迟到的
   答复不覆盖新偏好。
5. 宿主答不上来时退回自己解（`resolvedByHost` 缺席即就地读 `matchMedia`），拿不到
   系统值也好过整格主题停摆。
6. `ResolvedTheme` 收敛为一份定义，从 `webview/bridge.rs` 移到 `window/surface.rs`：
   解钉与回读都发生在这一层，浏览器桥只是消费者。同名两个 specta 类型会在生成绑定里
   撞车。

## Consequences

- 运行期切「跟随系统」当场跟随系统，两个方向都成立。
- 改偏好现在多一次 IPC 往返；投影晚一个微任务落地，衬底色与 `data-theme` 仍同帧一致。
- `window_set_surface` 保持原样：它仍是渲染层投影衬底色的唯一路径，只是不再独自承担
  「改偏好」这件事。
- ADR 0047 的启动落定、三层同步与 `activate()` 重应用均不变；本决策补上它运行期那一半。

## Evidence

- 现场复现（`poietica.log`，系统为浅色 `AppsUseLightTheme=1`）：
  - 修复前，`dark` 启动后切「跟随系统」：
    `PROBE runtime set: renderer-resolved color Color(32, 32, 32, 255), native window theme Ok(Dark)`
    —— 渲染层仍解出深色。
  - 同一台机器上以 `system` 冷启动是正确的：
    `startup surface adopted: preference System, resolved Light`
    —— 证明坏的只是运行期那一跳，不是解析本身。
  - 修复后，同样的切换动作：
    `PROBE runtime set: renderer-resolved color Color(243, 243, 243, 255), native window theme Ok(Light)`
    —— 解出浅色，与系统一致。
- 探针按 ADR 0046 记的办法加在 `WindowSurface::set` 与 `mount.tsx` 的临时触发上，
  取证后均已删除。
- 回归测试在 `window/surface.rs` 的 `tests::system_unpins_the_native_theme`：把
  `System` 改回 `Some(Theme::Dark)` 即失败，反向验证过这条断言不是空转。
- `prefers-color-scheme` 由原生主题推出的链路见 ADR 0047 的 Evidence
  （`tao-0.35.3` 的 `set_theme` → `wry-0.55.1` 的 `ICoreWebView2_13::Profile().SetPreferredColorScheme`）。
- `ipc:check` 通过：`ResolvedTheme` 只剩一份定义，`windowSetTheme` 在生成绑定里。
