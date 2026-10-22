import { type ComponentProps, type MouseEvent, useContext } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../control/tooltip'
import { FileTypeMark } from '../mark/file-type-mark'
import { ProseFileLinksContext } from './file-links-context'
import { type FileRef, fileRefOfHref } from './file-ref'

/*
 * 正文里的一处本地文件：文件类型图标（项目内联的 Material Icon Theme，与文件树同一套）+ 链接色文字，悬停给出完整路径，
 * 点了交给宿主（ProseFileLinksContext）在右坞开一个标签。链接文字照作者写的（多半就是文件名）；行内代码保留等宽字形。
 */

type AnchorProps = ComponentProps<'a'> & { readonly node?: unknown }

function placeOf(ref: FileRef): string {
  if (ref.line === null) return ref.path
  return ref.column === null
    ? `${ref.path}:${String(ref.line)}`
    : `${ref.path}:${String(ref.line)}:${String(ref.column)}`
}

export function FileLink({ children, className, href = '', node: _node, ...props }: AnchorProps) {
  const links = useContext(ProseFileLinksContext)
  const parsed = fileRefOfHref(href)

  if (parsed === null) {
    return <span className={className}>{children}</span>
  }
  const { origin, ref } = parsed
  if (links === null) {
    /* 没有宿主可开：行内代码原样画回去（不改变那些表面的样子），链接画成不可点的文件名 —— 总比 `[blocked]` 有用。 */
    return origin === 'code' ? (
      children
    ) : (
      <span className="prose-file-link" data-inert="">
        <FileTypeMark className="prose-file-link__mark" name={ref.path} />
        {children}
      </span>
    )
  }

  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    /* 地址是本产品自己的协议，浏览器不认：拦下默认导航，交给宿主。 */
    event.preventDefault()
    links.open(ref)
  }
  const anchor = (
    <a {...props} className={className} data-file-ref="" href={href} onClick={open}>
      <FileTypeMark className="prose-file-link__mark" name={ref.path} />
      {children}
    </a>
  )
  return (
    <Tooltip>
      <TooltipTrigger render={anchor} />
      <TooltipContent className="max-w-[24rem] break-all">{placeOf(ref)}</TooltipContent>
    </Tooltip>
  )
}
