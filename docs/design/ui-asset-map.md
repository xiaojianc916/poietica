# UI 资产归属表

查一个界面该放哪、该用哪个组件时先看这里。新增资产前先确认：表里没有同角色的东西。

## 1. design-system（通用，不认识业务）

| 资产                                                                                       | 入口 / 位置                           | 角色                               | 备注                                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| 令牌                                                                                       | `src/tokens/*.css`                    | 颜色、字号、圆角、阴影、动效、栈序 | 数值唯一产地                                                                           |
| `Button`                                                                                   | `src/control/button.tsx`              | 有外观的按钮                       | `default/destructive/dangerSoft/outline/secondary/soft/ghost`；`default/xs/sm/lg/icon` |
| `RowButton`                                                                                | **缺**                                | 无外观的整行/整卡点击              | 计划补；补前原生 `<button>` 只允许用于整行点击并登记                                   |
| `Accordion`                                                                                | `src/control/accordion.tsx`           | 折叠面板                           |                                                                                        |
| `Banner`                                                                                   | `src/control/banner.tsx`              | 页面级提示条                       |                                                                                        |
| `Dialog`                                                                                   | `src/control/dialog.tsx`              | 模态框                             | 自带浮层登记                                                                           |
| `ConfirmationDialog`                                                                       | `src/control/confirmation-dialog.tsx` | 二次确认                           | 不给调用方开放按钮颜色                                                                 |
| `DropdownMenu` 全家                                                                        | `src/control/dropdown-menu.tsx`       | 菜单 / 上下文菜单                  | 自带浮层登记                                                                           |
| `Select`                                                                                   | `src/control/select.tsx`              | 下拉选择                           |                                                                                        |
| `Tooltip`                                                                                  | `src/control/tooltip.tsx`             | 提示                               |                                                                                        |
| `SegmentedControl`                                                                         | `src/control/segmented-control.tsx`   | 表单内单选                         | 原生 radio 打底，有滑块                                                                |
| `ViewSwitch`                                                                               | `src/control/view-switch.tsx`         | 工具条视图切换                     | `aria-pressed` 按钮，无滑块                                                            |
| `Switch`                                                                                   | `src/control/switch.tsx`              | 开关                               |                                                                                        |
| `StateDot`                                                                                 | `src/control/state-dot.tsx`           | 状态点                             |                                                                                        |
| `ErrorState` / `InlineSpinner` / `LoadingState`                                            | `src/control/feedback.tsx`            | 反馈态                             |                                                                                        |
| `ToolbarMenu`                                                                              | `src/control/toolbar-menu.tsx`        | 工具条菜单按钮                     |                                                                                        |
| `WorkspacePicker`                                                                          | `src/control/workspace-picker.tsx`    | 项目选择                           | 已接受 `sidebar` / `composer` 两种落点                                                 |
| `GitBranchPicker`                                                                          | `src/control/branch-picker.tsx`       | 分支选择                           | 已接受 `data-assistant-skin`                                                           |
| `Input` / `Textarea` / `Checkbox` / `Radio`                                                | **缺**                                | 表单输入                           | 计划补；补前原生控件登记为例外                                                         |
| `SettingsPage` / `SettingsGroup` / `SettingRow` / `ToggleRow`                              | `src/settings-primitives.tsx`         | 设置页骨架                         | 设置页不得自绘行                                                                       |
| `RegionSplitter`                                                                           | `src/layout/region-splitter.tsx`      | 分栏拖拽                           |                                                                                        |
| `FileTree` / `pathTreeRows`                                                                | `src/tree/`                           | 文件树                             |                                                                                        |
| `FileTypeMark` / `integrationMarkFor` / `GithubMark`                                       | `src/mark/`                           | 文件/集成/品牌标记                 | 品牌色是资产数据，不进主题                                                             |
| `CjkText` / `TruncatedText`                                                                | `src/`                                | 中文断点 / 截断                    |                                                                                        |
| `cn` / `focusOnMount` / `formatBytes` / `useCopy` / `useScrollEnds` / `withViewTransition` | `src/`                                | 工具                               |                                                                                        |
| `overlay-presence`                                                                         | `src/overlay-presence.tsx`            | 浮层登记                           | 自绘浮层必须用                                                                         |
| prose                                                                                      | 子入口 `./prose`                      | Markdown 正文                      | 重依赖，单独子入口                                                                     |
| diff                                                                                       | 子入口 `./diff`                       | 统一 diff                          | 重依赖，单独子入口                                                                     |
| wave                                                                                       | 子入口 `./wave`                       | 流式波浪                           | 随 prose                                                                               |

## 2. conversation-kit（会话领域）

| 资产                                                                  | 位置                                 | 判定                 | 处置                                   |
| --------------------------------------------------------------------- | ------------------------------------ | -------------------- | -------------------------------------- |
| `agent-face` / `agent-face-motion`                                    | `src/primitives/`                    | 会话专属             | 留 kit                                 |
| `prompt-chip`                                                         | `src/primitives/`                    | 会话专属（输入区）   | 留 kit                                 |
| `tabs`                                                                | `src/primitives/tabs.tsx`            | 通用（有面板的页签） | 待裁决：下沉 DS 或留 kit               |
| `disclosure`                                                          | `src/primitives/disclosure.tsx`      | 通用折叠             | 待裁决：与 DS `Accordion` 角色是否重叠 |
| `use-scroll-mask`                                                     | `src/primitives/use-scroll-mask.tsx` | 通用滚动遮罩         | 待裁决：下沉 DS                        |
| `clock` / `external-store` / `icons` / `motion` / `use-device-pixels` | `src/primitives/`                    | 工具                 | 留 kit                                 |

判定标准：两个以上功能可用且不认识会话 → 通用；只在会话语境成立 → 领域件。

## 3. 功能自有

- 只在单个功能成立的视图：timeline 卡片、mascot、review 的 PR 视图、browser 的面板……
- 功能 CSS 只做布局与几何，规则见 `feature-css-boundary.md`。

## 4. 当前缺口（Phase 2 要补）

1. `Input`、`Textarea`、`Checkbox`、`Radio`：57 处原生控件没有替代。
2. `RowButton`：124 处原生 `<button>` 里相当一部分是整行点击。
3. `Tabs` / `Disclosure` / `ScrollMask` 的归属裁决。
4. 13px 字号角色：大量存量，没有工具类。
