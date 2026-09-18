/*
 * 浮层族的共用词汇：表面、定位层、菜单行。Menu、ContextMenu 与 Select 都认这一份，
 * 避免样式与栈序分叉。
 *
 * 不投影：产品要求浮层只有 1px 边框这一道界，靠边框与底色分层，不加高度感。
 * 这是整个浮层族的决定，单个弹层不要再自己补 shadow-*（补了就是第二个产地）。
 */
export const popupSurfaceClassName = [
  'overflow-hidden',
  'rounded-[10px] border border-divider',
  'bg-popover text-popover-foreground',
  'outline-none',
  'origin-[var(--transform-origin)]',
  'transition-[transform,scale,opacity]',
  'duration-[var(--ui-duration-fast)]',
  'ease-[var(--ui-ease-standard)]',
  'data-[starting-style]:scale-95',
  'data-[starting-style]:opacity-0',
  'data-[ending-style]:scale-95',
  'data-[ending-style]:opacity-0',
].join(' ')

/* 浮层一律落在 popover 层，组件内不得就地做层级算术。 */
export const popupPositionerClassName = 'z-[var(--ui-z-popover)] outline-none'

/*
 * 菜单里的一行。Menu 与 ContextMenu 认同一份：右键菜单不是另一种菜单，
 * 两族各写一套行样式，键盘高亮与行高就会先分叉，再没有一处能一起改。
 *
 * 行高读 --ui-menu-row-height；py-1 只在标签折行时参与计算。
 */
export const menuItemClassName = [
  'relative flex min-h-[var(--ui-menu-row-height)]',
  'cursor-default select-none',
  'items-center gap-2',
  'rounded-md px-2 py-1',
  'text-sm outline-none',
  'transition-colors',
  'focus:bg-[var(--ui-popup-highlight)]',
  'focus:text-foreground',
  'data-[highlighted]:bg-[var(--ui-popup-highlight)]',
  'data-[highlighted]:text-foreground',
  'data-[disabled]:pointer-events-none',
  'data-[disabled]:opacity-50',
].join(' ')

/*
 * 行的分隔线画成上边框，不画成 1px 的色块：150% 缩放下 1px 是 1.5 个设备像素，
 * 色块的框被吸附到设备像素边界，落在半格上就铺满两行 —— 同一次渲染里浮层外框量到
 * 1 行、这条线量到 2 行，所以它看着比外框粗；边框按整设备像素收边，位置再半格也是 1 行。
 *
 * -mx-1 抵消浮层的 p-1。颜色写在 --color-divider 的局部值上，不写 border-* 的颜色类：
 * app.css 里那条 `* { border-color: var(--color-divider) }` 是无层规则，压得过
 * @layer utilities 里的任何边框色类。
 */
export const menuSeparatorClassName =
  '-mx-1 my-1 border-t [--color-divider:var(--ui-popup-divider)]'
