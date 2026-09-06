import { type RefCallback, useCallback, useLayoutEffect, useRef, useState } from 'react'

export interface DockClearance {
  readonly ref: RefCallback<HTMLDivElement>
  readonly value: number | null
}

/**
 * 测量覆盖转录的输入区。首个 live 尺寸在绘制前发布，后续尺寸由 ResizeObserver 接管。
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
      publish(entries[0]?.borderBoxSize[0]?.blockSize ?? dock.getBoundingClientRect().height)
    })

    observer.observe(dock, { box: 'border-box' })
    return () => observer.disconnect()
  }, [active])

  return { ref, value }
}
