import { cn } from '../class-names'
import './state-dot.css'

/**
 * 会话状态的语义档：完成 / 等你介入 / 正在进行 / 出错 / 空闲。
 *
 * 与 DSH 的 StateDot 是同一套语义（正本 packages/client/ui-primitives/src/StateDot.tsx）：
 * - 只有 ongoing 不是「点」，而是一圈旋转 + 呼吸的弧；
 * - 其余四档都是同尺寸的实心点，颜色由状态决定；
 * - 所有实例的加载环共用一个动画起点，同一屏上不会各转各的。
 */
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/**
 * 把加载环的 CSS 动画钉在文档时间零点。
 *
 * 动画从元素插入时开始，元素被移动或重新显示时会重启；不钉起点，屏幕上同时出现的几个
 * 加载环就会越转越不同步。只在挂载与每次 animationstart 时钉一次。
 */
function syncSpinner(element: SVGSVGElement | null): void {
  if (element === null) return
  pinSpinner(element)
  element.addEventListener('animationstart', () => {
    pinSpinner(element)
  })
}

function pinSpinner(element: SVGSVGElement): void {
  /* happy-dom 的单测环境可能没有 Web Animations；缺了就让它自然转，别让组件挂掉。 */
  const spinner = element as { getAnimations?: SVGSVGElement['getAnimations'] }
  for (const animation of spinner.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0
}

/**
 * 一枚状态点。装饰性图形，状态文字由调用方放在同一行的读屏文本里。
 *
 * @param size 外径；ongoing 默认 14px，其余默认 10px
 */
export function StateDot({
  state,
  size,
  className,
}: {
  readonly state: StateDotState
  readonly size?: number | undefined
  readonly className?: string | undefined
}) {
  const edge = size ?? (state === 'ongoing' ? 14 : 10)

  if (state === 'ongoing') {
    return (
      <svg
        aria-hidden="true"
        className={cn('ui-state-dot', 'ui-state-dot--ongoing', className)}
        data-state="ongoing"

        style={{ width: edge, height: edge }}
        ref={syncSpinner}
        viewBox="0 0 24 24"
      >
        <g className="ui-state-dot__motion">
          <circle className="ui-state-dot__track" cx="12" cy="12" r="9.5" />
          <circle className="ui-state-dot__arc" cx="12" cy="12" r="9.5" />
        </g>
      </svg>
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn('ui-state-dot', className)}
      data-state={state}
      style={{ width: edge, height: edge }}
    />
  )
}
