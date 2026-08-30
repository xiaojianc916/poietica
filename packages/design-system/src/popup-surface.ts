/*
 * 浮层表面与定位层的唯一来源。
 *
 * Menu 与 Select 是同一种"浮在 chrome 之上的临时表面"，此前两个文件各写
 * 一遍，已经漂出两处差异：Menu 缺 ease-standard；Select 用
 * calc(--ui-z-dialog + 1) 绕过了栈序表，于是只有 Select 逃过了
 * "对话框内弹层被遮挡"，Menu 一直是坏的。差异不是设计意图，是抄漏。
 *
 * 阴影用 --ui-shadow-lg，不用 Tailwind 的 shadow-md / shadow-xl。
 *
 * 应用没有 @theme 重映射阴影刻度（见 apps/desktop/src/app.css 里那句裸的
 * @import "tailwindcss"），所以那两个类拿到的是 Tailwind 出厂值，与
 * shadows.css 是两套数。更要紧的是出厂值没有 [data-theme="dark"] 分支，
 * 暗色下不会从 16% 加深到 40%，浮层会糊进背景 —— Dialog 一直写的是
 * shadow-[var(--ui-shadow-xl)]，走的是令牌，此处与它对齐。
 */
/*
 * round 104：菜单在哪里打开都是同一个菜单。
 *
 * 圆角 8px 而不是 rounded-md（10px 级）：10px 是卡片圆角，落在 28px 的行上
 * 读起来是气泡。阴影换成三层紧阴影，扩散半径从 --ui-shadow-lg 的"浮起一张
 * 卡"收到"控件展开了一层"。两组值与编排器菜单（--am-radius / --am-shadow）
 * 同数，等到主题层收口时再合并成一处声明。
 */
export const popupSurfaceClassName = [
  'overflow-hidden',
  'rounded-[8px] border border-divider',
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
