import { Tooltip } from '@base-ui/react/tooltip'
import type { ComponentProps } from 'react'
import { cn } from '../class-names'
import { useOverlayRef } from '../overlay-presence'
import { popupPositionerClassName } from './popup-surface'

/*
 * 三个部件都从 Base UI 的命名空间直接展平，不再手搓转发：从 Radix 迁到 Base UI 只做了一半 ——
 * 类名换完了，属性名和包装留在原地。
 */
const TooltipProvider = Tooltip.Provider

const TooltipRoot = Tooltip.Root

/*
 * 触发器也是展平，理由比另外两个硬：那个包装不是多余，是错的。
 *
 * 它把 children 解构出来，然后再没往下传 —— 默认不置位那个布尔量时渲染出来是一个空按钮，
 * 而基元本身的标准用法恰恰就是直接给 children。
 *
 * 第二处：Children.only 是无条件调用的，排在那个布尔量的判断之前。于是「一个图标加一段文字」
 * 这种再普通不过的 children 直接抛异常，哪怕此时包装本该什么都不做。
 *
 * 旧 Provider 的毛病（传进来的属性运行时被静默丢掉）在这个函数对 children 上又犯了一遍；全仓
 * 唯一的调用点恰好置位了那个布尔量，雷才一直没踩到。
 */
const TooltipTrigger = Tooltip.Trigger

/*
 * 气泡的底与字只有令牌一个产地（tokens/light.css 与 dark.css 的 --ui-tooltip-*）：
 * 浅色反色（与它解释的界面对调明暗），深色改凹面（深色界面里反色是一块近白，比它解释的
 * 任何东西都亮）。主题差异全在令牌层，这里不写 [data-theme] 覆盖。
 *
 * 进出动画交给 Base UI 的 data-starting-style / data-ending-style。
 */
function TooltipContent({
  className,
  ref,
  side,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof Tooltip.Popup> & {
  readonly sideOffset?: number
  readonly side?: Tooltip.Positioner.Props['side']
}) {
  const overlayRef = useOverlayRef('anchored', ref)

  return (
    <Tooltip.Portal>
      <Tooltip.Positioner className={popupPositionerClassName} side={side} sideOffset={sideOffset}>
        <Tooltip.Popup
          className={cn(
            'ui-tooltip overflow-hidden rounded-md px-3 py-1.5 text-xs',
            'bg-[var(--ui-tooltip-surface)] text-[var(--ui-tooltip-ink)]',
            'origin-[var(--transform-origin)]',
            'transition-[transform,scale,opacity]',
            'duration-[var(--ui-duration-fast)] ease-[var(--ui-ease-standard)]',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className,
          )}
          ref={overlayRef}
          {...props}
        />
      </Tooltip.Positioner>
    </Tooltip.Portal>
  )
}

export { TooltipContent, TooltipProvider, TooltipRoot as Tooltip, TooltipTrigger }
