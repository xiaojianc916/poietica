# 多档选择的三种角色

## 背景

界面里出现四种「多选一」的实现：DS 的 `SegmentedControl`、DS 的 `ViewSwitch`、
conversation-kit 的 `Tabs`，以及 review 页面手写的 `role=tablist`。它们长得像，
语义并不相同；按长相选会让键盘行为与可访问名称错位。

## 规范

按角色选，不按长相选：

- **表单单选**（选项是同一份数据的几种取值）：`SegmentedControl`。原生 radio 打底，
  方向键、label 点击、`role=radiogroup` 都由浏览器与组件保证。
- **工具条视图切换**（这一面 / 那一面，例如 Preview / Source）：`ViewSwitch`。
  每档是一个 `aria-pressed` 按钮，不假装成表单。
- **有对应面板的页签**（上方是标签，下方是面板）：`Tabs`。必须是 `role=tablist` 语义。
- 不允许在功能里手写第四种实现。

## 实现位置

- `packages/design-system/src/control/segmented-control.tsx`
- `packages/design-system/src/control/view-switch.tsx`
- `packages/conversation-kit/src/primitives/tabs.tsx`
- 手写反例：`features/review/src/ui/pr-detail.tsx:183-198`（待替换为 `Tabs`）

## 影响面

设置页、右坞文件查看器、代码审查页、技能文档面板。

## 验收

- 新代码不再出现手写 `role=tablist` / 自绘分段控件。
- 三种角色的键盘行为与可访问名称分别符合 radiogroup / 按钮组 / tablist。
