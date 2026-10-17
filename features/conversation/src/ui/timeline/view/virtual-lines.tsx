import { useVirtualizer } from '@tanstack/react-virtual'

/*
 * 按行虚拟化，用在抽屉里的大段机器输出：几百行整段交给 markdown 管线要逐行分词建节点，而屏幕一次只看得到十行。判据是行数不是字节数 —— 建多少节点由行数决定。
 */

/** 超过这么多行就虚拟化。三百行约合七屏。 */
export const VIRTUAL_ABOVE_LINES = 300

/*
 * 与 row-estimate.ts 同一条规矩：--ui-prose-size-aux（0.8125rem）× --ui-line-height-normal（1.5）是正本，这里是它的读数。偏一点只影响滚动条总长，不会错位；measured 那档量出来的会覆盖它。
 */
const LINE_PX = 19.5

const OVERSCAN = 8

/*
 * 交进来的是元素不是 ref：虚拟器只在挂载那次读 getScrollElement()，而 React 挂 ref 在子组件布局副作用之后，子组件读父组件 ref 在挂载时必然是 null，观察者装不上，滚到底只画得出留白。回调 ref 一挂上就写 state，多出的那次渲染正赶上虚拟器重读元素。
 */
export function VirtualLines({
  className,
  lineClassName,
  lineHeight = LINE_PX,
  lines,
  measured = false,
  viewport,
}: {
  readonly className: string
  readonly lineClassName: string
  /** 首屏估高。正本在各消费者的字号令牌里，这里只收它的读数。 */
  readonly lineHeight?: number
  readonly lines: readonly string[]
  /** 一格会折行时置起：高度交给虚拟器量，估的那个数只是初值。 */
  readonly measured?: boolean
  readonly viewport: HTMLElement | null
}) {
  const virtualizer = useVirtualizer({
    count: lines.length,
    estimateSize: () => lineHeight,
    getScrollElement: () => viewport,
    overscan: OVERSCAN,
  })

  const items = virtualizer.getVirtualItems()
  const total = virtualizer.getTotalSize()
  const head = items[0]?.start ?? 0
  const tail = total - (items.at(-1)?.end ?? 0)

  return (
    <div className={className}>
      {/* 没画的那两段各占住自己的高度，否则滚动条会随着渲染缩掉。 */}
      <div style={{ blockSize: head }} />
      {items.map((item) => (
        <div
          className={lineClassName}
          data-index={measured ? item.index : undefined}
          key={item.key}
          ref={measured ? virtualizer.measureElement : undefined}
        >
          {lines[item.index] ?? ''}
        </div>
      ))}
      <div style={{ blockSize: tail }} />
    </div>
  )
}
