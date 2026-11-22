# 设置页只用设置原语

## 背景

设置页的行、组、页骨架如果各功能自绘，会出现三种行高、两种分隔线、两种标题层级。
`features/agent-settings` 是当前最整齐的参照：6 个文件、493 行、6 行 CSS，
版式全部来自 `SettingsPage` / `SettingsGroup` / `SettingRow` 与 `Select` / `Switch`。

## 规范

1. 设置页骨架只用 `SettingsPage` / `SettingsGroup` / `SettingRow` / `ToggleRow`。
2. 行内控件用 design-system 的 `Select` / `Switch` / `Input`（补齐后），不自绘。
3. 不在设置页写自定义行高、分隔线、标题字号；需要新样式先改 `settings.css` 或原语。
4. 设置页的导航与分组由 `settingsPages` / `settingsGroups` 贡献点提供，不直接改外壳。

## 实现位置

- `packages/design-system/src/settings-primitives.tsx`
- `packages/design-system/src/settings.css`
- 参照：`features/agent-settings/src/ui/`
- 贡献点：`packages/ui-kernel/src/builtin-points.ts` 的 `settingsPages` / `settingsGroups`

## 影响面

所有带设置页的功能（models、extensions、workbuddy、automations、usage……）。

## 验收

- 设置页 TSX 不出现自绘的行容器与分隔线。
- 同一设置组内行高、标题层级、控件高度一致。
