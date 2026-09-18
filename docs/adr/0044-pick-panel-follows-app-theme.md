# 0044. Pick panel follows the app theme

- Status: Accepted
- Date: 2026-09-18
- Owners: Desktop application composition root

## Context

元素拾取面板是注入外部页面的 closed Shadow DOM 脚本（`apps/desktop/src/browser/element-picker-runtime.ts`，
经 `build.rs` 打包、`child_view.rs` 以 initialization script 下发）。它读不到主窗口的
`:root[data-theme]`，此前只有一套手绘浅色调色板；深色模式下面板仍是白底。

候选信号有二：子 webview 的 `prefers-color-scheme`（只跟操作系统走，应用强制浅/深时失真），
或应用解析后的主题随启动调用传入。解析后主题的唯一真相是主窗口的 `data-theme` 属性。

## Decision

1. `browser_set_element_picker` 增加生成的 `ResolvedTheme`（`light | dark`）参数；渲染层从
   `:root[data-theme]` 读取，宿主把它拼进 `start(token, theme)`。主题是取样值，不随主题切换
   重推：拾取会话以秒计，重开拾取即换肤。
2. 面板 CSS 弃用私有调色板（`--ink/--muted/--line/--accent/--surface`），改用设计系统的
   `--ui-*` 令牌词汇；浅色值写在 `:host`，深色值写在 `:host([data-theme=dark])`，`color-scheme`
   随主题切换，原生 select 下拉与滚动条因此跟随。
3. 外部页面装不进设计系统样式表，令牌值在 runtime 内逐字抄写并注明正本
   （`packages/design-system/src/tokens/light.css` 与 `dark.css`），按仓库复制纪律同步。

## Consequences

- 面板与应用同皮：深色应用给出深色面板，视觉词汇（主色、焦点环、边框档位、错误色）与
  设计系统一致。
- 主题值存在一份带注释的抄本；design tokens 调整时 runtime 必须跟随，复制注释即提醒。
- 应用偏好切换主题时，已打开的面板保持取样时的主题，直到下一次拾取。
