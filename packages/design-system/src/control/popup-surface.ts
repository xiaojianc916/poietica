/*
 * Menu 与 Select 共用浮层表面与定位层，避免样式与栈序分叉。
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
