import type { ComponentProps } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../control/tooltip'

/*
 * 正文链接带一枚显示真实地址的悬停提示：markdown 的链接文字是作者随手起的，target=_blank 之后地址栏也不再教人它要去哪。
 * 用设计系统的 Tooltip 而不是 title：原生提示不受主题令牌控制，深色下是一块系统灰。
 */

/* 流式中未闭合的链接：href 是 streamdown 的哨兵值，不是去处，别把它当地址弹出来。 */
const INCOMPLETE = 'streamdown:incomplete-link'

type LinkProps = ComponentProps<'a'> & { readonly node?: unknown }

export function ProseLink({ children, className, href, node: _node, ...props }: LinkProps) {
  const anchor = (
    <a {...props} className={className} data-streamdown="link" href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  )

  if (href === undefined || href === INCOMPLETE) {
    return anchor
  }

  return (
    <Tooltip>
      <TooltipTrigger render={anchor} />
      {/* 地址无空格，长起来没有断点：限宽并从任意处断开，否则气泡横着长到屏幕外。 */}
      <TooltipContent className="max-w-[24rem] break-all">{href}</TooltipContent>
    </Tooltip>
  )
}
