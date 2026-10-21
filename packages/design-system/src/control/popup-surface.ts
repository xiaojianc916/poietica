/*
 * 浮层族的共用词汇：表面、定位层、菜单卡、菜单行、列标题、分隔线、选中勾。Menu 与 Select 都认
 * 表面与定位层这一份，避免样式与栈序分叉。
 *
 * 菜单这一族照 zcode 的通用菜单（packages/ui/src/components/ui/dropdown-menu.tsx 的
 * DropdownMenuContent / DropdownMenuItem）。zcode 把两件事分得很开：弹窗是 bg-popover + rounded-2xl
 * 的独立一层，菜单是 bg-menu + rounded-lg + 1px 边线的实色卡 —— 菜单从来不是玻璃。
 *
 *   卡   圆角 8（本仓 --ui-radius-md）、1px 描边、实色底、shadow-md、内边距 4、行间 2
 *   列   min-width 128、max-width 360
 *   行   最小 28 高、圆角 6（本仓 --ui-radius-sm）、内边距 4/8、字 14/1.625、图标与字间距 8
 *   标   14、内边距 6/8、三级字色
 *   分隔 高 1、横贯整卡
 *
 * 颜色全部照抄 zcode 的 .theme-zai-light / .theme-zai-dark 真值，不做「与某支令牌同档」的近似：
 *   底   --ui-menu        #ffffff / #2b2b2b（zcode --color-menu）
 *   悬停 --ui-menu-hover  #f0f0f0 / #363636（zcode --color-menu-hover）
 *   线   --ui-menu-border rgba(13,13,13,.1) / rgba(255,255,255,.1)（zcode --color-border，压在深色
 *        菜单底上兑出来就是 #414141）—— 边框与分隔线共用这一支，源码里本来就是同一个值。
 *
 * 菜单为什么不用玻璃底：菜单是贴着一个控件展开的选项表，玻璃底会把背后正文透进行间，选项的
 * 可读性就被背景决定了；透光的层次留给弹窗那一层。
 */
export const popupSurfaceClassName = [
  'overflow-hidden',
  'rounded-md',
  /*
   * 框色不在这里给：`* { border-color: var(--color-divider) }` 是无层规则，压得过任何 utilities，
   * 写在这里会被它吃掉。卡面那圈淡线由 control/menu.css 的 .ds-menu-card 统一声明。
   */
  'border',
  'bg-menu',
  'text-popover-foreground',
  'shadow-md',
  'outline-none',
  /*
   * 进出动画照 zcode 的 SelectContent / DropdownMenuContent：
   *   data-open:animate-in fade-in-0 zoom-in-95
   *   data-closed:animate-out fade-out-0 zoom-out-95
   *   data-[side=bottom]:slide-in-from-top-2 …（四条方向各一档，向触发器那一侧滑入）
   *   duration-100
   *
   * 本仓的浮层用 Base UI：方向写在弹层自己的 data-side 上（Positioner 也带着同一份属性），
   * 起始/结束态是 data-starting-style / data-ending-style。所以这里把同样的三件事——淡、缩、
   * 从触发器方向滑 8px——按本仓的属性名重写一遍，时长同样是 100。
   */
  'origin-[var(--transform-origin)]',
  'transition-[transform,scale,opacity,translate]',
  'duration-100',
  'ease-[var(--ui-ease-standard)]',
  'data-[starting-style]:scale-95',
  'data-[starting-style]:opacity-0',
  'data-[ending-style]:scale-95',
  'data-[ending-style]:opacity-0',
  'data-[starting-style]:data-[side=bottom]:translate-y-[-8px]',
  'data-[starting-style]:data-[side=top]:translate-y-[8px]',
  'data-[starting-style]:data-[side=left]:translate-x-[8px]',
  'data-[starting-style]:data-[side=right]:translate-x-[-8px]',
  'data-[ending-style]:data-[side=bottom]:translate-y-[-8px]',
  'data-[ending-style]:data-[side=top]:translate-y-[8px]',
  'data-[ending-style]:data-[side=left]:translate-x-[8px]',
  'data-[ending-style]:data-[side=right]:translate-x-[-8px]',
].join(' ')

/* 浮层一律落在 popover 层，组件内不得就地做层级算术。 */
export const popupPositionerClassName = 'z-[var(--ui-z-popover)] outline-none'

/*
 * 菜单卡（正本 .list）。宽度那两条（128 / 360）与内边距在这一格，调用点只再加自己的宽度。
 * ds-menu-card 是行内三格、两个变体与浮层滚动条的挂点：它们要看见卡，才谈得上「卡里的行」。
 */
export const menuCardClassName = [
  'ds-menu-card',
  'box-border flex flex-col gap-0.5',
  'min-w-32 max-w-[360px]',
  'p-1',
].join(' ')

/*
 * 菜单里的一行（正本 .item）。Menu 与 Select 认同一份：右键菜单不是另一种菜单，两族各写一套
 * 行样式，键盘高亮与行高就会先分叉。
 *
 * 最小 28 高、圆角 6、内边距 4/8、字 14/1.625、间距 8；字色就是页面正文那一档，不另开新档。
 * 高亮读 --ui-menu-hover（zcode 的 bg-menu-hover，深色 #363636、浅色 #f0f0f0）。行不写
 * transition-colors：正本里底色是瞬时切换的，指针一挪就该立刻跟过去。
 */
export const menuItemClassName = [
  'ds-menu-item',
  'relative flex w-full min-h-7',
  'cursor-default select-none',
  'items-center gap-2',
  'rounded-sm px-2 py-1',
  'border-none bg-transparent text-left',
  'text-sm leading-relaxed',
  'text-foreground',
  'outline-none',
  'hover:bg-menu-hover',
  'focus-visible:bg-menu-hover',
  'data-[highlighted]:bg-menu-hover',
  'data-[highlighted]:text-foreground',
  'data-[disabled]:pointer-events-none',
  'data-[disabled]:opacity-50',
].join(' ')

/*
 * 危险行（正本 .danger）：整行红字，高亮走软红底而不是中性高亮。图标不在这一份里 —— 它跟随
 * 行走，规则写在 control/menu.css 的 :not(.ds-menu-item-danger) 那一条上。
 */
export const menuItemDangerClassName = [
  'ds-menu-item-danger',
  'text-destructive',
  'hover:bg-[var(--ui-destructive-soft)]',
  'focus-visible:bg-[var(--ui-destructive-soft)]',
  'data-[highlighted]:bg-[var(--ui-destructive-soft)]',
  'data-[highlighted]:text-destructive',
].join(' ')

/*
 * 一组选项的标题行（正本 .label）：非交互的一行小字，内边距与行对齐。字色取占位那一档 ——
 * zcode 在这里用 foreground-subtlest，本仓同一角色就是 --ui-placeholder。
 */
export const menuLabelClassName = ['ds-menu-label', 'px-2 py-1.5', 'text-sm font-medium', 'text-placeholder'].join(' ')

/*
 * 分隔线：1px 高、横贯整卡（zcode 用 -mx-1 抹掉卡面那 4px 内边距）。
 *
 * 颜色走背景不走 border-color：styles.css 里那条 `* { border-color: var(--color-divider) }` 是无层
 * 规则，压得过 @layer utilities 里的任何边框色类。
 */
export const menuSeparatorClassName = 'ds-menu-separator -mx-1 my-1 h-px shrink-0 bg-menu-border'

/*
 * 选中那枚勾（正本 .check）：16 一格，颜色跟随行字，自己顶到行尾。
 */
export const menuCheckClassName = 'ds-menu-check ml-auto'

/*
 * 名单超过视口时在卡内滚（正本 .scrollable）：上限写进 control/menu.css 的 .ds-menu-scrollable，
 * 这里只做挂点。调用点在内容可能很长时戴上它。
 */
export const menuScrollableClassName = 'ds-menu-scrollable'
