import { Tooltip } from '@base-ui/react/tooltip'
import type { ComponentProps } from 'react'
import { cn } from './class-names'
import { popupPositionerClassName } from './popup-surface'

/*
 * 三个部件都从 Base UI 的命名空间直接展平，不再手搓转发。
 *
 * 此前 Provider 是个函数包装：它只转发三个属性，却把类型声明成 Tooltip.Provider
 * 的全部属性，而那一行里没有 rest spread —— 于是把别的属性传进来，类型检查通得
 * 过，运行时被静默丢掉。它对外收的也是 Radix 那个属性名，不是 Base UI 的 delay。
 *
 * 与下面注释里记着的 animate-in / data-[state=closed] 是同一笔账：从 Radix 迁到
 * Base UI 只做了一半 —— 类名换完了，属性名和包装留在原地。
 */
const TooltipProvider = Tooltip.Provider

const TooltipRoot = Tooltip.Root

/*
 * 触发器也是展平，理由比另外两个硬：那个包装不是多余，是错的。
 *
 * 它把 children 解构出来，然后再没往下传。默认不置位那个布尔量的时候，传下去
 * 的 render 是 undefined，children 又被吃掉了 —— 渲染出来是一个空按钮。基元本身
 * 的标准用法恰恰就是直接给 children（官方示例里是一个图标加一个 aria-label）。
 *
 * 第二处：Children.only 是无条件调用的，排在那个布尔量的判断之前。于是「一个图标
 * 加一段文字」这种再普通不过的 children 直接抛异常，哪怕此时包装本该什么都不做。
 *
 * 上面那段注释批评旧 Provider「把别的属性传进来，类型检查通得过，运行时被静默
 * 丢掉」—— 这个函数对 children 犯的是同一个错。全仓唯一的调用点恰好置位了那个
 * 布尔量，雷才一直没踩到。
 */
const TooltipTrigger = Tooltip.Trigger

/*
 * 反色是有意的：提示气泡与它解释的界面对调明暗，才不会被读成界面的一部分。
 *
 * 反色的来源必须是主题令牌，不是 dark: 变体。主题由 :root[data-theme] 驱动，
 * 而 dark: 读的是 prefers-color-scheme——用户手动切主题时两者会脱钩，气泡会朝
 * 着系统的方向翻过去。bg-foreground / text-background 天然跟随 data-theme：
 * 浅色下是深气泡，深色下是浅气泡，反色语义在两个主题里都成立。
 *
 * 进出动画交给 Base UI 的 data-starting-style / data-ending-style。此前这里是
 * 一串 animate-in / data-[state=closed] ——前者来自没有安装的 tailwindcss-animate，
 * 后者是 Radix 的属性名，Base UI 从不发出。整串类名一个都没生效过。
 */
function TooltipContent({
  className,
  side,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof Tooltip.Popup> & {
  readonly sideOffset?: number
  readonly side?: Tooltip.Positioner.Props['side']
}) {
  return (
    <Tooltip.Portal>
      <Tooltip.Positioner className={popupPositionerClassName} side={side} sideOffset={sideOffset}>
        <Tooltip.Popup
          className={cn(
            'overflow-hidden rounded-md px-3 py-1.5 text-xs',
            'bg-foreground text-background',
            'origin-[var(--transform-origin)]',
            'transition-[transform,scale,opacity]',
            'duration-[var(--ui-duration-fast)] ease-[var(--ui-ease-standard)]',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        />
      </Tooltip.Positioner>
    </Tooltip.Portal>
  )
}

export { TooltipContent, TooltipProvider, TooltipRoot as Tooltip, TooltipTrigger }
