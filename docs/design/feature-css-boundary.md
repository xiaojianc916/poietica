# 功能 CSS 的边界

## 背景

全仓功能 CSS 都不在 `@layer` 里（65 份、约 10,673 行）。按本仓层叠事实：
项目 CSS 无层，稳压 Tailwind 的 `@layer utilities`，与特异性、先后无关。
于是功能 CSS 天然能压过任何工具类；Q53 的「死工具类」就是这条通道的产物。
另有一批 `[data-theme]` 分支散在功能 CSS 里，主题差异没有全部留在令牌层。

## 规范

功能 CSS 只做 Tailwind 工具类表达不了的布局与几何：

1. 不写颜色字面值；需要角色时读 `var(--ui-*)`。
2. 不写 `[data-theme]` 分支；两主题差异进令牌层。
3. 不覆盖 design-system 组件的内部类名；需要新外观先改 design-system。
4. 不写全局选择器（`html` / `*` / `:root`）；确需全局的回到 `tokens/`。
5. 每个文件头注释写清：负责哪块布局、为什么工具类不够。
6. 新文件按归属放进对应子层：design-system → `components.ds`、conversation-kit →
   `components.kit`、workbench → `components.workbench`、功能 → `components.features`。
   层序在 renderer 入口声明：`theme < base < vendor.xterm < components.ds < components.kit <
components.workbench < components.features < utilities < overrides < prose`。
   第三方 CSS 进 `vendor.*` 层（目前只有 xterm），不能无层；`overrides` 收主题相关、
   必须盖过工具类的组件皮肤；`prose` 排在 `utilities` 之后：streamdown 给标题/代码硬编码工具类。

## 实现位置

- 现状：`features/conversation/src/ui/*.css`（28 份）、`features/composer`（14 份）等
- 闸门：`tooling/checks/style-boundaries.ts`（S1/S3/S4/S6/S7/S9/S10/S11）
- 层叠事实与迁移步骤：`tidy-poietica-frontend` 的 `references/frontend-map.md`

## 影响面

全部功能 UI 的样式通道；动到选择器/层叠时按 L1/L2/L3 验证。

## 验收

- 新增功能 CSS 不含颜色字面值、主题分支、全局选择器。
- 存量计数只降不升；例外表有归属。
