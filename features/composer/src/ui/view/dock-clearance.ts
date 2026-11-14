import { type RefCallback, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

export interface DockClearance {
  readonly ref: RefCallback<HTMLDivElement>
  readonly value: number | null
}

/**
 * 测量覆盖转录的输入区；首个尺寸在绘制前发布，之后由 ResizeObserver 接管。
 *
 * 之后的每一次也必须在**同一帧**发布：输入区浮在转录上面，它变高变矮（发出一段多行的话后清空、
 * 附件条收起）是这一帧就画出来的，转录末尾的留白若晚一帧才跟上，钉在末端的整段对话就先错开一帧
 * 再追上 —— 读出来是「抖了一下」。ResizeObserver 的回调在布局之后、绘制之前，在这里 flushSync
 * 让转录的留白与滚动补偿落进同一次绘制。
 */
export function useDockClearance(active: boolean): DockClearance {
  const node = useRef<HTMLDivElement | null>(null)
  const [value, setValue] = useState<number | null>(null)

  const ref = useCallback<RefCallback<HTMLDivElement>>((current) => {
    node.current = current
  }, [])

  useLayoutEffect(() => {
    const dock = node.current

    if (!active || dock === null) {
      setValue(null)
      return
    }

    let published = -1
    const publish = (height: number) => {
      const next = Math.round(height)
      if (next === published) {
        return
      }
      published = next
      setValue(next)
    }

    publish(dock.getBoundingClientRect().height)

    const observer = new ResizeObserver((entries) => {
      flushSync(() => {
        publish(entries[0]?.borderBoxSize[0]?.blockSize ?? dock.getBoundingClientRect().height)
      })
    })

    observer.observe(dock, { box: 'border-box' })
    return () => observer.disconnect()
  }, [active])

  return { ref, value }
}
