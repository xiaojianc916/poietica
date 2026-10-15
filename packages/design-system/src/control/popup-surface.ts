/*
 * 浮层族的共用词汇：表面、定位层、菜单卡、菜单行、列标题、分隔线、选中勾。Menu 与 Select 都认
 * 表面与定位层这一份，避免样式与栈序分叉。
 *
 * 几何逐条照抄 DeepSeek Harness 的 MenuSurface.module.css 与 Menu.module.css
 * （@deepseek-ai/dsh-client-ui-primitives，装机版本 2026-10-01）；行内三格、两个变体与浮层滚动条
 * 在 control/menu.css：
 *   卡   圆角 16（--dsw-radius-lg）、无 border、玻璃底 specific-menu（40px 模糊 + 150% 饱和）、
 *        elevation-prominent = 0 0 0 .5px 描边 + 0 3px 8px + 0 0 20px
 *   列   min-width 144、max-width 360、内边距 4、纵向排列、行间不额外留白（.list）
 *   行   34 高、圆角 12（--dsw-radius-md）、内边距 6px 8px、字 13/20、图标与字间距 6（.item）
 *   标   11/15、内边距 6px 8px、三级字色（.label）
 *   分隔 高 .5、外边距 3px 2px（.separator）
 *
 * 那圈描边走 box-shadow 而不是 border：玻璃底上 border 会沿圆角切出一道实边，而 0.5px 的投影
 * 描边贴着圆角走。整个浮层族只有这一个产地，单个弹层不要再自己补 shadow-*。
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
 * 菜单卡（正本 .list）。宽度那两条（144 / 360）与内边距在这一格，调用点只再加自己的宽度。
 * ds-menu-card 是行内三格、两个变体与浮层滚动条的挂点：它们要看见卡，才谈得上「卡里的行」。
 */
export const menuCardClassName = [
  'ds-menu-card',
  'box-border flex flex-col',
  'min-w-36 max-w-[360px]',
  'p-1',
].join(' ')

/*
 * 菜单里的一行（正本 .item）。Menu 与 ContextMenu 认同一份：右键菜单不是另一种菜单，两族各写一套
 * 行样式，键盘高亮与行高就会先分叉。
 *
 * 行高读 --ui-menu-row-height（34），圆角取 --ui-radius-xl（12），内边距 6/8，字 13/20，
 * 图标与字间距 6；字色读 --ui-popup-ink（正本 --dsw-alias-label-primary，比页面正文更黑一档）。
 * 指针是高亮的判据（正本 cursor: pointer），所以行不写 transition-colors —— 那一格底色在正本里
 * 是瞬时切换的。
 */
export const menuItemClassName = [
  'ds-menu-item',
  'relative flex w-full min-h-[var(--ui-menu-row-height)]',
  'cursor-pointer select-none',
  'items-center gap-1.5',
  'rounded-xl px-2 py-[6px]',
  'border-none bg-transparent text-left',
  'text-[13px] leading-5',
  'text-[var(--ui-popup-ink)]',
  'outline-none',
  'hover:bg-[var(--ui-popup-highlight)]',
  'focus-visible:bg-[var(--ui-popup-highlight)]',
  'data-[highlighted]:bg-[var(--ui-popup-highlight)]',
  'data-[disabled]:pointer-events-none',
  'data-[disabled]:opacity-40',
].join(' ')

/*
 * 危险行（正本 .danger）：整行红字，悬停与键盘高亮走软红底而不是中性高亮。图标不在这一份里 ——
 * 它跟随行走，规则写在 control/menu.css 的 :not(.ds-menu-item-danger) 那一条上。
 */
export const menuItemDangerClassName = [
  'ds-menu-item-danger',
  'text-[var(--ui-popup-danger)]',
  'hover:bg-[var(--ui-popup-danger-highlight)]',
  'focus-visible:bg-[var(--ui-popup-danger-highlight)]',
  'data-[highlighted]:bg-[var(--ui-popup-danger-highlight)]',
].join(' ')

/*
 * 一组选项的标题行（正本 .label）：非交互的一行小灰字，内边距与行对齐，字比行小一档。
 * 颜色读 --ui-popup-label（正本 --dsw-alias-label-tertiary）。
 */
export const menuLabelClassName = [
  'ds-menu-label',
  'px-2 py-[6px]',
  'text-[11px] leading-[15px]',
  'text-[var(--ui-popup-label)]',
].join(' ')

/*
 * 分隔线是 0.5px 的色块，不是 1px 的上边框：150% 缩放下 1px 边框会栅格化成 2 个设备像素，
 * 而外框那圈描边只有 1 个，内线于是看着比外框粗 —— 与粗细关系正好相反。
 *
 * 颜色走背景不走 border-color：styles.css 里那条 `* { border-color: var(--color-divider) }` 是无层
 * 规则，压得过 @layer utilities 里的任何边框色类。
 */
export const menuSeparatorClassName =
  'ds-menu-separator mx-0.5 my-[3px] h-[0.5px] shrink-0 bg-[var(--ui-popup-divider)]'

/*
 * 选中那枚勾（正本 .check）：14 一格，颜色是行字那一档，自己顶到行尾。
 *
 * 顶到行尾这一条本仓要自己出：正本靠 .itemLabel 的 flex: 1 把勾挤到右边，而本仓的行不接管
 * children 的形状，行里可能只有一段裸文字 —— 那样的行盒里没有可撑开的格子。写 margin 得到
 * 同一张画面，且两种情况都对。
 */
export const menuCheckClassName = 'ds-menu-check ml-auto'

/*
 * 名单超过视口时在卡内滚（正本 .scrollable）：上限写进 control/menu.css 的 .ds-menu-scrollable，
 * 这里只做挂点。调用点在内容可能很长时戴上它。
 */
export const menuScrollableClassName = 'ds-menu-scrollable'
