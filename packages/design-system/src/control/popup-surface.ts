/* Menu 与 Select 共用浮层表面与定位层，避免样式与栈序分叉。 */
export const popupSurfaceClassName = [
  'overflow-hidden',
  'rounded-[10px] border border-divider',
  'bg-popover text-popover-foreground',
  'shadow-[0_0_0_0.5px_color-mix(in_srgb,var(--ui-foreground)_4%,transparent),0_1px_2px_color-mix(in_srgb,var(--ui-foreground)_6%,transparent),0_8px_24px_-8px_color-mix(in_srgb,var(--ui-foreground)_18%,transparent)]',
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
