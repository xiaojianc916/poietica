import { useVirtualizer } from '@tanstack/react-virtual'
import { type RefObject, useCallback, useMemo, useState } from 'react'

import { cx } from '../primitives/class-names'
import { useDevicePixels } from '../primitives/use-device-pixels'
import { ProseSegment } from './prose'
import { createBlockScanner } from './split-stream'

/**
 * 一段 markdown，只画看得见的那几块。
 *
 * 「高度有上限、内容量无上限、只有一个窗口可见」是虚拟化的定义性场景，而这个应用里
 * 满足它的地方有两处：思考链，以及工具调用抽屉里的载荷。此前只有前者做了 —— 那台机器
 * 整个长在 ReasoningPanel 内部，抽屉想要就只能抄一遍。
 *
 * 所以它搬到这里。切分归 createBlockScanner，渲染归 ProseSegment，两者与回答那条流完全
 * 同款（prose.tsx 导出 ProseSegment 时说的正是这件事）；这一层只回答「哪些块此刻在屏幕
 * 上」，而这个答案两处一模一样。
 *
 * 滚动容器不归它。调用方才知道那个盒子是什么 —— 思考盒是一个普通的裁剪盒，抽屉那个是
 * 一个 role=\"tabpanel\"。把它造在这里，调用方就只能隔着 prop 往里塞属性，而 ARIA 角色
 * 恰恰是最不该被塞进来的东西。这一层要的只是「往哪个盒子里量」，那就是一个 ref。
 *
 * 滚动位置同样不归它，而且是同一条理由的延长：盒子的主人才知道这个盒子该不该跟着最新
 * 内容走 —— 思考链边写边看要跟，工具载荷要从头读起不能跟。这里因此一个 scrollTop 都不
 * 写，也不判「贴没贴底」：那两件事都在盒子的主人那边，由 follow-latest 承担。
 */

/**
 * 一个逻辑行的估高：安静档字号（--ui-prose-size-quiet）乘行高，约 19px。
 *
 * 它是下界，不是预测 —— 一行文字换行之后只会更高。按转录那一层这张估高表自己声明
 * 的口径：「估小了只是补偿一次，估大了会在到达前留白」，下界落在安全的那一侧。
 */
const ESTIMATED_LINE_PX = 19

/** 视口之外预留的块数。块比转录的行小得多，四块盖得住一次滚轮的位移。 */
const OVERSCAN_BLOCKS = 4

export interface VirtualProseProps {
  /** 包含块自己的类；.timeline-prose 由这一层补上，两个调用点的排版因此同源。 */
  readonly bodyClassName: string
  readonly isStreaming: boolean
  /** 往哪个盒子里量。那个盒子归调用方，连同它的角色与它的边。 */
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly text: string
}

export function VirtualProse({ bodyClassName, isStreaming, scrollRef, text }: VirtualProseProps) {
  /*
   * 一条流一个切分器：进度跟着这个组件实例走（useState 的惰性初始化，一个实例只造一次）。
   *
   * 一次线性扫描，没有解析：切点只看行首字符与围栏配平。封口的块内容不再变，所以每一块
   * 正好被解析一次；正在写的那一块是最后一块。
   */
  const [split] = useState(createBlockScanner)

  const blocks = useMemo(() => split(text), [split, text])

  /* 落点要踩在设备像素上：半个像素会把块里 1px 的边摊到两行、墨色减半。 */
  const snapToDevicePixels = useDevicePixels()

  /*
   * 身份是块的起始行号。
   *
   * 块只追加，封口之后内容不再变，所以这个数恒定且唯一 —— 而且正在写的那一块封口
   * 时它的起始行号不变，于是它已经测到的高度不会因为「它现在算封口的了」而作废。
   */
  const getItemKey = useCallback((index: number) => blocks[index]?.key ?? index, [blocks])

  const estimateSize = useCallback(
    (index: number) => {
      const block = blocks[index]

      return block === undefined ? ESTIMATED_LINE_PX : block.lines * ESTIMATED_LINE_PX
    },
    [blocks],
  )

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN_BLOCKS,
    /* 单引擎渲染器（WebView2），原生 scrollend 可用；理由见 AgentActivityFeed 同一处。 */
    useScrollendEvent: true,
  })

  const items = virtualizer.getVirtualItems()
  const live = blocks.length - 1

  return (
    <div
      className={cx('timeline-prose', bodyClassName)}
      data-streaming={isStreaming ? 'true' : undefined}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {items.map((item) => {
        const block = blocks[item.index]

        if (block === undefined) {
          return null
        }

        return (
          <div
            className="timeline-prose__block"
            data-first={item.index === 0 ? 'true' : undefined}
            data-index={item.index}
            key={item.key}
            ref={virtualizer.measureElement}
            style={{
              transform: `translateY(${String(snapToDevicePixels(item.start))}px)`,
            }}
          >
            <ProseSegment isStreaming={isStreaming && item.index === live} text={block.text} />
          </div>
        )
      })}
    </div>
  )
}
