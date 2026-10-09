import { useVirtualizer } from '@tanstack/react-virtual'

/*
 * 一段长文本的画法：按行虚拟化。两个消费点同一套机器：抽屉里的大段机器输出
 * （tool-call-panels）与展开的推理（thought-card）。几百行的产出整段交给 markdown
 * 管线不划算 —— 每行都要分词建节点，而屏幕一次只看得到十行；过阈值就只画视口里
 * 那几行，没画的两头各留一段空白占住高度。
 *
 * 差别只有一处：机器输出等宽不折行、高度恒定；推理是散文，一格会折行，高度得量
 * （measured）。判据是行数不是字节数：要建多少节点由行数决定。
 */

/** 超过这么多行就虚拟化。三百行约合七屏，再往下画的人也只是在滚。 */
export const VIRTUAL_ABOVE_LINES = 300

/*
 * 一个行盒的高度：--ui-prose-size-aux（0.8125rem）× --ui-line-height-normal（1.5），
 * 与 row-estimate.ts 同一条规矩 —— 令牌是正本，这里是它的读数。
 *
 * 只用来估高度，行多高由 CSS 给，偏一点也只是滚动条总长偏，不会错位；measured 那档
 * 量出来的会覆盖它。
 */
const LINE_PX = 19.5

/** 视口上下各多画几行，快速滚动时才不露白。 */
const OVERSCAN = 8

/*
 * 滚动容器是外面那个盒子，交进来的是元素不是 ref。虚拟器只在挂载那次读
 * getScrollElement()，而 React 挂 ref 在子组件布局副作用之后（commitAttachRef 在
 * 递归子节点之后）—— 子组件读父组件 ref 在挂载时必然是 null，之后也没人再读：
 * 观察者装不上，滚到底只画得出留白。回调 ref 一挂上就写 state，多出的一次渲染
 * 正赶上虚拟器重读元素，观察者那时接上。
 */
export function VirtualLines({
  className,
  lineClassName,
  lines,
  measured = false,
  viewport,
}: {
  readonly className: string
  readonly lineClassName: string
  readonly lines: readonly string[]
  /** 一格会折行时置起：高度交给虚拟器量，估的那个数只是个初值。 */
  readonly measured?: boolean
  readonly viewport: HTMLElement | null
}) {
  const virtualizer = useVirtualizer({
    count: lines.length,
    estimateSize: () => LINE_PX,
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
          /* 量高度要按 index 认行：虚拟器靠它把量到的值写回自己那张表。 */
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
