import { useVirtualizer } from '@tanstack/react-virtual'

/*
 * 一大段机器输出的画法：按行虚拟化。
 *
 * 抽屉里的那一面本来是整段交给 markdown 管线的。产出长到几百行时那一步就不划算了 ——
 * 每一行都要分词、要建节点，而屏幕上一次只看得到十行。过了阈值就换这一条路：只画视口
 * 里那几行，没画的两头各留一段空白把高度占住。
 *
 * 代价是这一面不再是 markdown：不上色，也不再有 markdown 结构。会长到三百行以上的东西
 * 是机器输出 —— 一次搜索的全部命中、一整份文件正文、一段 JSON —— 它们本来就是一行一条
 * 的记录，而抽屉作用域里围栏的外壳与复制按钮早被摘掉（tool-call.css 的 __prose 一节），
 * 所以换过来的画面与原来基本相同。
 *
 * 判据是行数不是字节数：屏幕上要建多少个节点，由行数决定。
 */

/** 超过这么多行就虚拟化。三百行约合七屏，再往下画的人也只是在滚。 */
export const VIRTUAL_ABOVE_LINES = 300

/*
 * 一个行盒的高度：--ui-prose-size-aux（0.8125rem）× --ui-line-height-normal（1.5）。
 * 与 row-estimate.ts 同一条规矩 —— 令牌是正本，这里是它的读数，换算写在注释里。
 *
 * 它只用来估高度，行本身多高由 CSS 给（同样那两条令牌）。所以这个数偏一点也不会错位：
 * 行在文档流里，永远首尾相接；偏的只是滚动条总长。
 */
const LINE_PX = 19.5

/** 视口上下各多画几行，快速滚动时才不露白。 */
const OVERSCAN = 8

/*
 * 滚动容器是外面那个面板，元素本身由父组件交进来 —— 而且交的是元素，不是 ref。
 *
 * 这不是风格问题。虚拟器只在挂载的那一次读 getScrollElement()，而 React 挂 ref 是在
 * 布局阶段、子组件的布局副作用跑完之后（commitAttachRef 在递归子节点之后）。所以
 * 「子组件读父组件那个 ref」在挂载时必然是 null，之后也没人再读一次：观察者一个都没
 * 装上，滚到底也只画得出一段留白。
 *
 * 用状态就对了：回调 ref 一挂上就写进 state，多出来这一次渲染正赶上虚拟器重读元素，
 * 观察者在那时接上。
 */
export function ToolOutputLines({
  lines,
  viewport,
}: {
  readonly lines: readonly string[]
  readonly viewport: HTMLDivElement | null
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
    <div className="timeline-tool__output">
      {/* 没画的那两段各占住自己的高度，否则滚动条会随着渲染缩掉。 */}
      <div style={{ blockSize: head }} />
      {items.map((item) => (
        <div className="timeline-tool__output-line" key={item.key}>
          {lines[item.index] ?? ''}
        </div>
      ))}
      <div style={{ blockSize: tail }} />
    </div>
  )
}
