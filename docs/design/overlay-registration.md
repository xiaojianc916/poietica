# 浮层必须登记

## 背景

原生视图（浏览器面板）画在整页 DOM 之上，只能靠 `overlay-presence` 的登记知道
该不该让路。浮层没有登记时，菜单、提示、下拉会被原生视图盖住。此前已经出现过
自绘浮层漏登记的问题。

## 规范

1. 优先用 design-system 的 `Dialog` / `DropdownMenu` / `Select` / `Tooltip`：
   它们自己登记，调用方不用管。
2. 功能里自绘浮层（`createPortal`、第三方弹层）必须用 `useOverlayRef`（贴边浮层）
   或 `useModalOverlay`（模态浮层）登记。
3. 浮层内容根如果依赖作用域变量（`--cp-*`、`--settings-*`），必须把作用域属性挂到
   Portal 内容根上（范例：`threads-header.tsx` 的 `DropdownMenuContent` 挂
   `data-assistant-skin`），不要靠 `:root` 兜底。
4. 不给浮层加兜底值来「修」作用域问题；兜底生效说明作用域错了。

## 实现位置

- `packages/design-system/src/overlay-presence.tsx`
- 合规范例：`features/composer/src/ui/view/context-gauge.tsx:201`
- 规范出处：`docs/ARCHITECTURE.md` §4.3、`AGENTS.md` §9

## 影响面

所有菜单、提示、对话框、悬浮卡、命令面板。

## 验收

- 打开原生浏览器面板时，已登记的浮层让路，未登记的不会出现。
- 自绘浮层在浅/深主题下都能取到正确的令牌值（无兜底生效）。
