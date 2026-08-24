import './conversation-minimap.css'

import type { ConversationTurn } from '@poietica/agent'
import { memo, useCallback } from 'react'
import { turnIndexAtRow } from '../threads/ordered-lookup'
import { groupTurns, RAIL_MAX_BARS } from './rail-groups'
import { useFisheye } from './use-fisheye'
import { useFoldFlip } from './use-fold-flip'
import { useRailCard } from './use-rail-card'

/**
 * The turn rail: the table of contents of the conversation, on the edge.
 *
 * One bar per turn while they fit; once they do not, one bar per run of turns.
 * It reads a row index and reports a row index — the scrollport owns the
 * scrolling, and this owns nothing but the pointing.
 *
 * 为什么要并格,而不是让轨道自己滚动:一个需要自己滚动的导航条已经不是导航条
 * 了,它把"看见全局"这唯一的用途还给了被导航的东西。格数有上限而轮次无界,
 * 只能压缩表示,不能延长轨道。
 *
 * Native buttons in a nav, so keyboard order, focus and activation come from
 * the platform; the bars are spans because a bar is paint, not a target.
 */
export interface ConversationMinimapProps {
  readonly turns: readonly ConversationTurn[]
  /** 人正在读的那一行;跳转期间是人要求看的那一行。 */
  readonly activeRow: number
  /** 更早的轮次还没读回来：那时轨道画的不是全局，总数也就无从谈起。 */
  readonly hasEarlier: boolean
  readonly onSelect: (rowIndex: number) => void
}

function Rail({ activeRow, hasEarlier, onSelect, turns }: ConversationMinimapProps) {
  const fisheye = useFisheye()
  const card = useRailCard()

  /*
   * 分格只看轮次,不看滚动位置。
   *
   * 高亮(activeRow)只挑格,不改格:格子的数量与身份是轮次的纯函数,人上下滚动
   * 时一根都不许增减 —— 「第 40 轮大概在那个高度」这类空间记忆是导航条的第一
   * 性质,滚动条与编辑器的 overview ruler 同理。
   *
   * 不包 useMemo,理由和下面的二分一样:这是一次 O(N) 的遍历,而这个组件被
   * memo 包着、滚动帧里根本不重渲染。
   */
  const items = groupTurns(turns, RAIL_MAX_BARS)

  /*
   * 有序数组上求"最后一个不晚于当前行的一格",这是二分。
   *
   * 并格没有破坏前提:桶首的 rowIndex 仍然严格递增,所以二分照旧成立,答案从
   * "第几轮"变成"第几格",而那正是要高亮的东西。
   */
  const active = turnIndexAtRow(items, activeRow)

  /*
   * 折叠动画的触发条件：格子的身份序列变了。它只有在并格结果算完之后才说得出口，
   * 所以这个 hook 排在 items 之后 —— 顺序就是数据的顺序。
   */
  const flip = useFoldFlip(items.map((item) => item.id).join('|'))

  /*
   * 三件事落在同一个节点上:指针、预览卡、折叠动画。
   *
   * 一套协议,三个参与者:每一路都收下节点、都交回一个清理函数,合并之后仍然只是
   * 一个清理函数 —— React 19 在卸载时调用它,而返回了清理函数的 ref 回调不会再被
   * 以 null 调用一次。此前 flip 是唯一的例外:它不返回清理,靠的正是那次 null 调用
   * 撒手,而合并把那次调用吃掉了。
   *
   * 依赖都是引用稳定的(useCallback 空依赖),所以这个回调不会每帧换身份,节点也就
   * 不会每帧被反复解绑重绑。
   */
  const setRail = useCallback(
    (node: HTMLElement | null) => {
      const detach = [fisheye(node), card(node), flip(node)]

      return () => {
        for (const off of detach) {
          off?.()
        }
      }
    },
    [card, fisheye, flip],
  )

  /*
   * 每格都要念一遍「共 N 轮」，但 N 一格一格地不会变。
   *
   * 更早的轮次还没读回来时不报总数：报一个只涵盖已读部分的 N 是谎报位置，比不报更坏。
   */
  const total = hasEarlier ? null : String(turns.length)

  return (
    <nav aria-label="会话轮次" className="conversation-minimap" ref={setRail}>
      {items.map((item, index) => {
        /*
         * 序数在前,内容在后。
         *
         * 这一条在视觉上是一根短横,它在整根轨道里的位置就是它全部的空间信息;
         * 而读屏用户拿不到这份信息 —— 只报内容,等于让人自己数到第几根。
         *
         * 并格之后更要报区间:一格代表八轮却只报一个序数,是在谎报位置。
         */
        const span =
          item.kind === 'cluster'
            ? `第 ${String(item.from)}–${String(item.to)} 轮`
            : `第 ${String(item.ordinal)} 轮`
        const position = total === null ? span : `${span}，共 ${total} 轮`

        const label = `${position}：${item.label}`

        return (
          <button
            /*
             * location,不是 true。WAI-ARIA 把 location 定义为"在环境或上下文中的
             * 当前位置",目录里被高亮的那一项正是它举的例子;true 只说"是当前的",
             * 没说是哪一种当前。样式不再挑 token,只看属性在不在。
             */
            aria-current={index === active ? 'location' : undefined}
            aria-label={label}
            className="conversation-minimap__turn"
            data-card-kicker={
              item.kind === 'cluster' ? `${String(item.to - item.from + 1)} 项` : undefined
            }
            data-card-label={item.label}
            data-card-reply={item.reply}
            data-rail-id={item.id}
            key={item.id}
            /*
             * 一格一个闭包,就这样。下面的 memo 让这些闭包一年也建不了几次,
             * 为它们做共享处理器 + data-row 往返,是拿真实的复杂度去换一个不
             * 存在的开销。
             */
            onClick={() => {
              onSelect(item.rowIndex)
            }}
            type="button"
          >
            <span className="conversation-minimap__bar" />
          </button>
        )
      })}

      {/*
       * 一张卡片,不是每格一张。
       *
       * 内容由 use-rail-card 写入:文字仍然是 React 产出的(在按钮的 data-card-*
       * 上),这里只是那些文字唯一的落脚处。aria-hidden 照旧 —— 读屏拿的是按钮的
       * aria-label,那份文案已经把序数、区间和标题说全了。
       */}
      <div aria-hidden="true" className="conversation-minimap__card">
        <p className="conversation-minimap__card-kicker" hidden />
        <p className="conversation-minimap__card-question" />
        <p className="conversation-minimap__card-reply" hidden />
      </div>
    </nav>
  )
}

/**
 * 滚动帧里整棵跳过。
 *
 * 滚动区每一帧都重渲染 —— 虚拟器必须如此 —— 于是浮层每帧被调用一次,产出一个新
 * 元素,React 就得逐个比对 N 个按钮和 N 张卡片。但这些入参在构造上就是引用稳定
 * 的:turns 走投影的弱表缓存(selectPresentation 在轮次没变时交还同一个数组),activeRow
 * 是数字且跨行才变,onSelect 经 scrollToRow 落到 scroll-authority 的 reveal —— 那条
 * useCallback 链引用稳定。所以浅比较几乎总是命中。
 *
 * 并格让被比对的元素数量有了上限:即便浅比较落空,代价也不再随会话长度增长。
 */
export const ConversationMinimap = memo(Rail)
