import { fileHrefOf, fileRefOfCode, fileRefOfTarget } from './file-ref'

/*
 * remark 插件：把指向本地文件的链接与行内代码改写成 `poietica-file:` 地址（解析规则在 file-ref.ts）。
 *
 * 为什么回到源码取链接目标而不是用 node.url：CommonMark 的反斜杠转义会吃掉 ASCII 标点前的反斜杠，`C:\repo\.github\_x.md`
 * 进了 mdast 就成了 `C:\repo.github_x.md` —— Windows 路径正好满是这种组合。位置信息在，就按原文切；切不出来才退回 node.url。
 *
 * 不引 unist-util-visit：要的只是一次深度优先，自己走一遍比多一个依赖清楚。节点形状只写用得到的那几格。
 */

interface Point {
  readonly offset?: number | undefined
}
interface MdNode {
  type: string
  url?: string
  value?: string
  children?: MdNode[]
  position?: { readonly start: Point; readonly end: Point } | undefined
}
interface VFileLike {
  readonly value?: unknown
}

function sliceOf(source: string, node: MdNode): string | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? null : source.slice(start, end)
}

const BLANK = new Set([' ', '\n', '\t'])

/* 裸目标：到第一个空白、或到配不上对的那个收尾括号为止（反斜杠转义的字符跳过）。走到头都没收尾即不成立。 */
function bareDestination(text: string): string | null {
  let depth = 0
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? ''
    if (char === '\\') {
      at += 1
      continue
    }
    if (BLANK.has(char) || (char === ')' && depth === 0)) return text.slice(0, at)
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
  }
  return null
}

/* `<dest>` 或裸目标（括号要配平）。 */
function destinationAt(text: string): string | null {
  if (!text.startsWith('<')) return bareDestination(text)
  const close = text.indexOf('>')
  return close < 0 ? null : text.slice(0, close + 1)
}

/* 行内链接 `[label](dest "title")`：目标从标签之后的 `](` 起。标签里本身可能有 `](`，所以从最后一个孩子的结尾往后找。 */
function linkDestination(source: string, node: MdNode): string | null {
  const text = sliceOf(source, node)
  const start = node.position?.start.offset
  if (text === null || start === undefined || !text.startsWith('[')) return null
  const lastChild = node.children?.at(-1)?.position?.end.offset
  const from = lastChild === undefined ? 1 : lastChild - start
  const open = text.indexOf('](', from)
  if (open < 0) return null
  return destinationAt(text.slice(open + 2).replace(/^[ \t\n]+/u, ''))
}

/* 定义 `[id]: dest "title"`。 */
function definitionDestination(source: string, node: MdNode): string | null {
  const text = sliceOf(source, node)
  if (text === null) return null
  const colon = /^\[(?:[^\]\\]|\\.)*\]:[ \t]*\n?[ \t]*/u.exec(text)
  if (colon === null) return null
  const rest = text.slice(colon[0].length)
  return destinationAt(`${rest} `)
}

function rewriteLink(node: MdNode, source: string): void {
  const raw = (node.type === 'link' ? linkDestination(source, node) : definitionDestination(source, node)) ?? node.url
  if (raw === undefined) return
  const ref = fileRefOfTarget(raw)
  if (ref !== null) node.url = fileHrefOf(ref, 'link')
}

/* 行内代码就地换成「链接包着行内代码」：画的那一层据 from=code 决定是画成文件链接，还是原样画回代码。 */
function linkedCode(node: MdNode): MdNode | null {
  const ref = node.value === undefined ? null : fileRefOfCode(node.value)
  if (ref === null) return null
  return { type: 'link', url: fileHrefOf(ref, 'code'), children: [{ ...node }], position: node.position }
}

function walk(node: MdNode, source: string, insideLink: boolean): void {
  if (node.type === 'link' || node.type === 'definition') rewriteLink(node, source)
  const children = node.children
  if (children === undefined) return
  const nested = insideLink || node.type === 'link' || node.type === 'linkReference'
  for (let at = 0; at < children.length; at += 1) {
    const child = children[at]
    if (child === undefined) continue
    const replaced = !nested && child.type === 'inlineCode' ? linkedCode(child) : null
    if (replaced !== null) children[at] = replaced
    else walk(child, source, nested)
  }
}

export function remarkFileRefs() {
  return (tree: MdNode, file: VFileLike): void => {
    walk(tree, typeof file.value === 'string' ? file.value : '', false)
  }
}
