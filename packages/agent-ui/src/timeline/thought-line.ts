import { type Fence, fenceAfter } from './split-stream'

/*
 * 一段推理压成一行安全的纯文本。
 *
 * 那一格印的是「写到哪儿了」，不是文档：围栏、表格、标题的形要靠块级排版才立得住，
 * 塞进一行只剩一串断掉的符号。点开之后仍走 Prose 那条 markdown 管线，所以这里丢掉
 * 的只是标记，不是内容。
 */

/** 行首的块记号：标题、引用、列表、表格竖线。 */
const BLOCK_MARK = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+|\|)/

/** 只有记号、没有字的一行：分隔线，以及表格的对齐行。 */
const RULE_ROW = /^\s{0,3}(?:[-*_]\s*){3,}$|^\s{0,3}\|?[\s:|-]+\|?\s*$/

/** 行内标记去壳：图片整个丢掉，链接留字，其余只去记号。 */
function unmark(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~|\*/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** tail 是正在写的那一行，head 是收起之后当摘要的第一句。 */
export type ThoughtEdge = 'head' | 'tail'

export function readThoughtLine(text: string, edge: ThoughtEdge): string {
  let fence: Fence = 'none'
  let head = ''
  let tail = ''

  for (const row of text.split('\n')) {
    const after = fenceAfter(row, fence)

    /* 围栏本身那两行也算在围栏里：开合与内容一律不上这一格。 */
    if (after !== 'none' || fence !== 'none') {
      fence = after

      continue
    }

    const line = RULE_ROW.test(row) ? '' : unmark(row.replace(BLOCK_MARK, ''))

    if (line === '') {
      continue
    }

    tail = line

    if (head === '') {
      head = line

      if (edge === 'head') {
        break
      }
    }
  }

  return edge === 'head' ? head : tail
}
