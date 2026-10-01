# 0011. Window surface reads the shell chrome color

- Status: Accepted
- Date: 2026-09-19
- Owners: Desktop application composition root

## Context

ADR 0007 定了三层同步的机制，没有定"哪一格颜色"。衬底当时取的是页面底色：
浅色纯白、深色 `#181818`（`--ui-background` / `--ui-palette-dark-950`）。

拖拽与还原露出的那一圈不是页面。主面板带四角圆角与右、下留白，缺口里露出来的
是工作区外壳的地色 `--ui-chrome`（`workspace-shell.tsx` 的 `bg-chrome`）。衬底与
它不同色，露底时窗口边缘就多出一条与周围对不上的带子。

颜色也没有正本：宿主那份是纯数据，写不了注释；调色板那格是 oklch 派生式；
`window-surface-policy` 只核对 theme-runtime、index.html、宿主创建底色三份抄本
互相相等 —— 三者一起改错同样全绿。

## Decision

1. 衬底取 `--ui-chrome`，与它露出的那一圈同色：浅色 `#f3f3f3`、深色 `#202020`。
2. 正本移到 `packages/design-system/src/tokens/palette.css` 的 `--ui-palette-neutral-75`
   与 `--ui-palette-dark-850`，写字面十六进制。窗口早于 webview 存在、读不到 CSS，
   正本必须能被取色器逐字核对。
3. `light.css` / `dark.css` 的 `--ui-chrome` 必须指向这两格。
4. theme-runtime 的 RGB 投影、index.html 的预运行初稿、`electron/main.ts` 的创建底色是
   三份抄本，`window-surface-policy` 逐份核对与正本相等；抄本处注明正本路径。
5. 运行期同步必须成对设两层（见下），`window-surface-policy` 守住这一对。

## 衬底是两层，不是一层

衬底由两个独立表面组成，创建期与运行期各有一处：

| 层 | 创建 | 运行期 |
| --- | --- | --- |
| 原生窗口 | `new BrowserWindow({ backgroundColor })` | `win.setBackgroundColor(…)` |
| 渲染进程视图 | 同一次创建，视图继承窗口底色 | `win.setBackgroundColor(…)` 同时改两层 |

Tauri 时代这个「两层」是两条独立的消息，运行期只调窗口那条，渲染层那条就停在创建值，
表现为"两层底色，一层对一层是 `#f3f3f3`"。**Electron 里这个失败模式不存在**：
`win.setBackgroundColor` 改的就是窗口自己的底色，渲染进程视图没有第二个可分别设置的
表面。ADR 0028 之后表里的第二行不是第二个表面，而是同一次创建在渲染进程侧的结果。

## Consequences

- 拖拽、还原、托盘唤醒露出的那一层与窗口边缘同色，不再是页面底色，也不再是
  一层对一层错。
- 改衬底是"调色板一格 + 三份抄本"；漏改哪一份，`bun run test:architecture` 指名报出。
- ADR 0007 的三层同步机制、宿主所有权与恢复入口不变。

## Evidence

- 浅色正本 `oklch(0.9642 0 0)` 换算 sRGB 为 243.015，即 `#f3f3f3`：本次改写是等值换写法。
- 判据在 `tools/architecture/charters.ts` 的 `themeSurfaceIsAligned`。
- 运行期证据在 `tools/dev/probe-window-surface.ts`：加载真实构建产物，在 Chromium
  （与 Electron 同引擎）里让样式引擎把 `--ui-chrome` 解析成 rgb()，与衬底色逐通道比。
  它验的是闸门验不了的那半句 —— 三份字面值相等不等于屏幕上同色。改色后重建产物即失效，
  这正是它该有的性质。
- 两层的存在与各自的落地由 Electron 给出：`BrowserWindow` 构造参数的 `backgroundColor`
  是创建期，`win.setBackgroundColor(…)` 是运行期；渲染进程视图与窗口不是两个可分别
  设置的表面（这是两层收敛成一层的原因）。
- 运行期证据：设置页真实点选颜色模式后，主进程日志每次都能看到窗口底色与
  `nativeTheme.themeSource` 成对落同色（`rgb(32 32 32)` 与 `rgb(243 243 243)` 各一对）。
- 未取到的证据，留在这里以免下次重复踩：衬底只在拖拽/缺帧那一瞬可见，静态截图上
  量不到它 —— 页面自身背景始终盖着它。`Page.captureScreenshot` 截的是网页内容；
  屏幕截图在窗口被遮挡时会量到别的窗口（实测抓到过背后浏览器的 `#121212`）；
  `PrintWindow` 能拿到窗口自身内容，但那一刻衬底并不露出。**衬底颜色只有拖拽窗口
  时肉眼可见**，自动化能验的是"命令成对下发且成功"，验不了"肉眼观感"。
