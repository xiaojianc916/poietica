# Poietica Design System

这份文档是界面与样式的**使用规范**，给人和 coding agent 看。它只写语义、边界与规则；
颜色、字号、圆角、阴影、动效的数值只在 `src/tokens/*.css` 定义，本文不抄第二份。

写界面之前先读这里；拿不准时按本文的默认值走，并把新情况补成 `docs/design/` 的一篇决策记录。

## 最高优先级约束

1. **界面文字只用语义字号档**：`text-micro`、`text-caption`、`text-xs`、`text-sm`、
   `text-base`、`text-lg`，以及 prose 自己的 `--ui-prose-*`。
   不写 `text-[13px]` 这类任意值，不写内联 `fontSize`，不在功能 CSS 里新开字号。
   违反按**设计系统缺陷**处理，不是风格偏好。
2. **不从令牌目录之外写颜色**。用 `semantic.css` 提供的工具类（`bg-background`、
   `text-foreground-subtle`、`border-divider`……），或读 `var(--ui-*)`。
   组件私有变量可以定义在组件自己的 CSS 里，但必须在定义处注释角色。
3. **功能里不自绘通用控件**。先查本文的资产表；表里没有的，先补 design-system，
   再在功能里用。确属功能独有的视图，留在功能里。
4. **浮层必须登记**。DS 的 Dialog / DropdownMenu / Select / Tooltip 已自己登记；
   功能自绘的 `createPortal` / 第三方弹层必须用 `useOverlayRef` / `useModalOverlay`。
5. **改视觉不是整理**。任何会改变计算样式的改动，先记 Q、先给基准，不许夹在重构里。

## 四类资产

| 资产       | 位置                                        | 主人负责什么                                          | 不许做什么                                        |
| ---------- | ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| 令牌       | `packages/design-system/src/tokens/`        | 颜色、字号、圆角、阴影、动效、栈序的**唯一数值产地**  | 在功能里另起一套主题变量                          |
| 通用控件   | `packages/design-system/src/`               | 不认识业务的控件与富界面（prose、diff、tree、mark）   | 调 RPC、持有功能 store、import 功能 `contract`    |
| 会话领域件 | `packages/conversation-kit/src/primitives/` | 只在会话语境成立的原语（`agent-face`、`prompt-chip`） | 放通用控件（Tabs、Disclosure、ScrollMask 待裁决） |
| 功能界面   | `features/<id>/src/ui/`                     | 组合上面三类，写本功能独有的布局与视图                | 复制通用控件、另立字号/颜色体系                   |
| 外壳       | `packages/workbench/`                       | 布局、侧栏、面板坞、设置框架，只渲染贡献点            | import 任何 `@poietica/feature-*`                 |

**下沉判定**：两个以上功能要画、且不认识业务的界面 → 进 design-system；
只在一个功能成立 → 留在功能里，哪怕它很大（ARCHITECTURE §4.3）。

## 令牌

导入顺序即层叠顺序，见 `src/styles.css` 头注：

```
palette → typography → scales → controls → assistant → rows → layers
→ light → dark → semantic → surface → ...
```

- 颜色：`palette.css` 是原色；`light.css` / `dark.css` 是两主题的 `--ui-*`；
  `semantic.css` 的 `@theme` 才是功能能用的工具类词汇表。
- 主题差异只在令牌层或组件私有变量里表达。功能 CSS 里出现 `[data-theme]` 分支按缺陷处理。
- 令牌名也是接口：TS、测试、内联 style 会按字符串读它。改名/改值前全仓搜。

## 字号与排印

| 档                      | 当前解析值 | 用途                                                    |
| ----------------------- | ---------- | ------------------------------------------------------- |
| `text-micro`            | 10px       | 仅限紧凑 chrome 的角标；不用于正文                      |
| `text-caption`          | 11px       | 辅助说明、徽章、弱元数据                                |
| `text-xs`               | 12px       | 次级标签、紧凑控件、时间戳                              |
| `text-sm`               | 14px       | **默认正文与控件文字**                                  |
| `text-base`             | 16px       | 阅读标题、对话框标题                                    |
| `text-lg`               | 18px       | 二级阅读标题                                            |
| `text-xl`               | 20px       | 页面副标题（存量）                                      |
| `text-2xl` / `text-3xl` | 24 / 30px  | 页面级标题（存量：功能首页、编辑器标题）                |
| prose `--ui-prose-*`    | 14/13/12   | 模型输出的连续正文；级差在 prose 内用 em 相对根字号表达 |

- 13px 目前是存量档，没有对应工具类。**新代码不要新写 13px**：优先 `text-sm`，
  确属紧凑说明用 `text-caption`；等 13px 的角色表裁决后再统一。
- 字号与颜色是独立决定：先选档，再选语义色。
- 图标不跟字号缩放；图标尺寸用 `size-*`，不用 em。

## 间距、圆角、阴影、动效、栈序

- 间距走 4px 网格；优先 4/8/12/16/20/24，不写任意 `w-[…]` / `h-[…]`。
- 圆角只用 `rounded-sm|md|lg|xl|2xl|full`，映射见 `scales.css`；胶囊才用 `rounded-full`；
  不写 `rounded-[10px]`，不用裸 `rounded`。
- 阴影只用 `shadow-xs|sm|md|lg|xl`；布局层级主要靠底色与边框，不靠重阴影。
- 动效只用 `--ui-duration-*` 与 `--ui-ease-*`；动效解释状态变化，不做装饰。
- 栈序只用 `layers.css` 的层；不在组件里写 `calc(var(--ui-z-*) + 1)`，不写新 z-index 字面值。

## 组件

公开面以 `src/index.ts` 为准；子入口按重依赖切开（`./diff`、`./prose`、`./wave`）。

- 有外观的按钮用 `Button`（`variant` / `size`）；整行/整卡点击用 `RowButton`（补齐后）；
  不要再写一个带 `<button>` 的第 N 种实现。
- 表单：`Input` / `Textarea` / `Checkbox` / `Radio`（补齐后）优先；设置页用
  `SettingsPage` / `SettingsGroup` / `SettingRow` / `ToggleRow`。
- 三种「多档选择」按角色选，不按长相选：
  - `SegmentedControl`：表单里的单选（原生 radio 打底，有滑块）。
  - `ViewSwitch`：工具条里的视图切换（`aria-pressed` 按钮，无滑块）。
  - `Tabs`（conversation-kit）：有对应面板的页签（`role=tablist` 语义）。
- 菜单/浮层用 `DropdownMenu` / `Select` / `Tooltip` / `Dialog`；不要在功能里手写弹层。
- 组件 API 是设计决策的一部分：能不给调用方留的口子就不留（例如确认框只给一个
  `destructive` 布尔，不开放任意 `variant` / 颜色）。功能的 `className` 只用于布局
  （外边距、宽度），不改组件外观。

## 功能 CSS

功能 CSS 只做 Tailwind 工具类表达不了的布局与几何：

- 不写颜色字面值；需要角色时读令牌。
- 不写主题分支；两主题差异进令牌。
- 不覆盖 design-system 组件的内部类名；需要新外观先改 design-system。
- 不写全局选择器（`html` / `*` / `:root`）；确需全局的回到 tokens。
- 新文件必须自带角色注释：这份 CSS 负责哪块布局、为什么工具类不够。

## 浮层与可访问性

- 浮层优先级：DS Dialog > DS DropdownMenu/Select/Tooltip > 自绘（必须登记）。
- 键盘路径是一等公民：每个可点元素可聚焦、有可见焦点、有可读名称。
- 不靠颜色单独表达状态；状态色配文字。
- 文案要容得下中英文长度变化；不用「只对短英文成立」的固定宽度。

## 已知例外（不要扩散）

- `tokens/assistant.css` 的 `--cp-*` 是会话皮肤，功能可读；新角色不要再加进这里。
- `prose` 读少量 `--cp-*`、`WorkspacePicker` 带 `placement`、`GitBranchPicker` 带
  `data-assistant-skin`：这是已接受的业务耦合，新代码不得照此扩张。
- 功能 CSS 里存量的 `[data-theme]` 分支与任意值，按 `docs/design/feature-css-boundary.md`
  的预算只减不增。

## 变更流程

1. 新增令牌：先证明现有令牌没有这个角色；在 `tokens/` 加，补两主题解析值与注释。
2. 新增控件：先查 `docs/design/ui-asset-map.md`；加在 `src/control/`，补行为测试与导出。
3. 新增视觉规则：写一篇 `docs/design/*.md`（背景 → 规范 → 实现位置 → 影响面 → 验收），
   再改代码。
4. 改计算样式：按 `tidy-poietica-frontend` 的 L1/L2/L3 证明；`bun run all` 不绿不提交。

## Do / Don't

Do：

- 先查资产表，再决定放哪。
- 用语义工具类与角色档。
- 让组件 API 表达设计决策。
- 把新例外写进文档与闸门预算。

Don't：

- 在功能里写 hex / rgb / hsl。
- 写 `text-[13px]`、`rounded-[10px]`、`w-[…]` 这类任意值。
- 用 `!important` 压 design-system。
- 为了一次替换新增一堆同值令牌（洗值）。
- 把「看起来差不多」当成同一角色。
