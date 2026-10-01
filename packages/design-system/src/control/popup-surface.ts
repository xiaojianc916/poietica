/*
 * 浮层族的共用词汇：表面、定位层、菜单行。Menu、ContextMenu 与 Select 都认这一份，
 * 避免样式与栈序分叉。
 *
 * 材质照抄 DeepSeek Harness 的 MenuSurface.module.css 与 Menu.module.css（正本：
 * @deepseek-ai/dsh-client-ui-primitives，取 2026-10-01 的装机版本）：
 *   卡   圆角 16（正本 --dsw-radius-lg）、无 border、玻璃底 specific-menu（40px 模糊 +
 *        150% 饱和）、elevation-prominent = 0 0 0 .5px 描边 + 0 3px 8px + 0 0 20px
 *   行   34 高、圆角 12（正本 --dsw-radius-md）、内边距 6px 8px、字 13/20、图标与字间距 6
 *   分隔 高 .5、外边距 3px 2px
 *
 * 那圈描边走 box-shadow 而不是 border：正本就没有 border —— 玻璃底上 border 会
 * 沿圆角切出一道实边，而 0.5px 的投影描边贴着圆角走。整个浮层族只有这一个产地，
 * 单个弹层不要再自己补 shadow-*。
 */
export const popupSurfaceClassName = [
  'overflow-hidden',
  'rounded-2xl',
  'bg-[var(--ui-popup-surface)]',
  '[backdrop-filter:blur(40px)_saturate(150%)]',
  'shadow-[var(--ui-popup-elevation)]',
  'text-popover-foreground',
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
 * 行高读 --ui-menu-row-height（正本 34），圆角取 --ui-radius-xl（12，正本 --dsw-radius-md），
 * 内边距 6/8，字 13/20，图标与字间距 6 —— 逐条对应正本 .item。
 */
export const menuItemClassName = [
  'relative flex min-h-[var(--ui-menu-row-height)]',
  'cursor-default select-none',
  'items-center gap-1.5',
  'rounded-xl px-2 py-[6px]',
  'text-[13px] leading-5 outline-none',
  'transition-colors',
  'focus:bg-[var(--ui-popup-highlight)]',
  'focus:text-foreground',
  'data-[highlighted]:bg-[var(--ui-popup-highlight)]',
  'data-[highlighted]:text-foreground',
  'data-[disabled]:pointer-events-none',
  'data-[disabled]:opacity-40',
].join(' ')

/*
 * 分隔线是 0.5px 的色块，不是 1px 的上边框：正本 .separator 就是 height:.5px 加
 * 一条背景。150% 缩放下 1px 边框会栅格化成 2 个设备像素，而外框那圈描边只有 1 个，
 * 内线于是看着比外框粗 —— 与正本的粗细关系正好相反。
 *
 * 颜色走背景不走 border-color：app.css 里那条 `* { border-color: var(--color-divider) }`
 * 是无层规则，压得过 @layer utilities 里的任何边框色类。
 */
export const menuSeparatorClassName =
  'mx-0.5 my-[3px] h-[0.5px] shrink-0 bg-[var(--ui-popup-divider)]'
