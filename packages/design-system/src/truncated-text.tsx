import { type ComponentPropsWithRef, type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from './class-names'

/*
 * 省略号只在文本真的被裁掉时配一条完整文本的提示。
 *
 * title 属性由 overflow 实测决定，不做「一律挂 title」：没被裁的短标签悬停时弹出一个和眼前
 * 一模一样的框，只会挡住下一行。ResizeObserver 管父栏收放，window resize 管窗口变化；
 * 字体换挡不改盒宽，但会改 scrollWidth，所以 document.fonts 就绪后再量一次。
 */
export interface TruncatedTextProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  readonly children: ReactNode
  /** 子节点不是纯文本时，用它作为完整文本；仍然只在真的被裁掉时挂 title。 */
  readonly fullText?: string
}

export function TruncatedText({ children, className, fullText, ...props }: TruncatedTextProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)
  const label = fullText ?? (typeof children === 'string' || typeof children === 'number' ? String(children) : '')

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    let disposed = false
    const measure = (): void => {
      if (!disposed) setClipped(node.scrollWidth > node.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    const mutations = new MutationObserver(measure)
    mutations.observe(node, { childList: true, characterData: true, subtree: true })
    window.addEventListener('resize', measure)
    void document.fonts?.ready.then(measure)
    return () => {
      disposed = true
      observer.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return (
    <span
      className={cn('ds-truncate', className)}
      ref={ref}
      title={clipped && label !== '' ? label : undefined}
      {...props}
    >
      {children}
    </span>
  )
}
