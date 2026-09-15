import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import type { ComponentProps } from 'react'

/*
 * 正文里的链接带一枚悬停提示，显示它真正指向的地址。
 *
 * markdown 的链接文字是作者随手起的（「GitHub 仓库」），而 target=_blank 之后地址栏
 * 也不再教人它要去哪 —— 地址本身是这条链接唯一没说出口的事实。
 *
 * 走设计系统的 Tooltip 而不是 title：原生提示不受主题令牌控制，深色下是一块系统灰。
 * 延迟不在这里另立一份，取外壳挂在根上的那个 Provider（workspace-shell 的 450ms）。
 *
 * 覆写 streamdown 的链接组件，就得把它原本的义务接下来：target 与 rel 是它的默认值，
 * data-streamdown 是它的标记。它那串类名不重抄 —— 落到链接上的外观（颜色、虚线、
 * 断行）归 timeline.css 的 .timeline-prose a，一处说清。
 */

/* 流式中未闭合的链接：href 是 streamdown 的哨兵值，不是去处，别把它当地址弹出来。 */
const INCOMPLETE = 'streamdown:incomplete-link'

type LinkProps = ComponentProps<'a'> & { readonly node?: unknown }

export function ProseLink({ children, className, href, node: _node, ...props }: LinkProps) {
  const anchor = (
    <a
      {...props}
      className={className}
      data-streamdown="link"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  )

  if (href === undefined || href === INCOMPLETE) {
    return anchor
  }

  return (
    <Tooltip>
      <TooltipTrigger render={anchor} />
      {/* 地址无空格，长起来没有断点；限宽并允许从任意处断开，否则气泡会横着长到屏幕外。 */}
      <TooltipContent className="max-w-[24rem] break-all">{href}</TooltipContent>
    </Tooltip>
  )
}
