import { useCallback, useLayoutEffect, useRef } from 'react'

import { DisclosureBody, useDisclosure } from '../primitives/disclosure'
import { useFollowLatest } from '../primitives/follow-latest'
import { ChevronDownIcon, ThinkingIcon } from '../primitives/icons'
import { VirtualProse } from './virtual-prose'

export interface ReasoningPanelProps {
  readonly text: string
  readonly isStreaming: boolean
}

/**
 * The thought chain.
 *
 * Not a card: a card would give a passing remark the same weight as an answer.
 * One quiet line that can be opened, and the thinking underneath it — rendered
 * by the same pipeline as the answer, because it is the same kind of content.
 *
 * 正在思考时展开，思考完毕收起；人点过一次之后以人为准。判据与工具卡片同一个，
 * 语义写在 useDisclosure。
 *
 * The prose is always mounted: unmounting it is why the panel used to snap
 * open, as there is nothing to animate between a node and no node. It lives in
 * a grid row that travels between 0fr and 1fr, the one way an intrinsic height
 * animates without being measured in script. Closed, the row is inert, so its
 * content is out of reach of the keyboard and of a screen reader.
 *
 * A long chain scrolls within a capped box rather than pushing the answer down
 * the page. The cap is a maximum, so a short chain has no scroller and no
 * scrollbar at all.
 *
 * 而「内容量无上限、只有一个窗口可见」的那一半已经不在这个文件里了。它此前整台机器
 * 长在这里 —— 切分、估高、末端锚定、设备像素对齐 —— 而工具抽屉里的载荷是同一种场景。
 * 一个问题一个答案：那台机器搬进 VirtualProse，这里只剩下属于思考链自己的三件事：
 * 什么时候展开、盒子长什么样、以及「边写边打开时先看最新一行」。
 */
export function ReasoningPanel({ isStreaming, text }: ReasoningPanelProps) {
  const { isOpen, toggle } = useDisclosure(isStreaming)

  /* 滚动容器归这一层：那个盒子的上限与滚动条写在它自己的类里，滚动位置也归它。 */
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const { release, resume, stick, watch } = useFollowLatest()

  /*
   * 盒子的主人装订它自己的跟随。
   *
   * 一个 ref 回调做两件事：登记元素给虚拟窗口量高度，装上跟随的监听。一个盒子一处装卸，
   * 而 React 19 的 ref 回调可以交回卸载函数，所以不需要第二个效应去对齐它的生命周期。
   */
  const bindScroll = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element

      if (element === null) {
        return
      }

      return watch(element)
    },
    [watch],
  )

  /*
   * 边写边看才跟，写完或收起就让开。
   *
   * 收起时让开是必要的：再打开时人要看的是最新一行，而不是上次离开的地方 —— 那一下由
   * resume 自己拨。写完让开也是必要的：思考完毕之后这段内容不再长，而一个还举着旗的
   * 跟随只会在人向上读时跟他抢位置。
   */
  const chasing = isOpen && isStreaming

  useLayoutEffect(() => {
    if (chasing) {
      resume()

      return
    }

    release()
  }, [chasing, release, resume])

  /*
   * 每次提交之后拨一次末端。
   *
   * 这一层在 VirtualProse 之外,所以它的布局效应跑在后者提交之后 —— 新的一块已经落进
   * DOM,盒子的高度是新的。同一帧完成,看不见中间态。
   *
   * 没有依赖数组是刻意的:每一次重渲染都可能改变这个盒子的高度,而这里不需要区分是哪
   * 一种。stick 只在人还跟着最新内容时写一次 scrollTop,写的值与当前值相同时浏览器连
   * 事件都不派发。
   */
  useLayoutEffect(() => {
    stick()
  })

  return (
    <div className="timeline-reasoning" data-open={isOpen ? 'true' : undefined}>
      <button
        aria-expanded={isOpen}
        className="timeline-reasoning__toggle"
        onClick={toggle}
        type="button"
      >
        <ThinkingIcon aria-hidden="true" className="timeline-reasoning__mark" />

        <span className="timeline-reasoning__label">{isStreaming ? '正在思考' : '思考完毕'}</span>

        <ChevronDownIcon
          aria-hidden="true"
          className="timeline-reasoning__chevron disclosure__chevron"
        />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-reasoning__scroll" ref={bindScroll}>
          <VirtualProse
            bodyClassName="timeline-reasoning__body"
            isStreaming={isStreaming}
            scrollRef={scrollRef}
            text={text}
          />
        </div>
      </DisclosureBody>
    </div>
  )
}
