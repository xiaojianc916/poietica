/*
 * 收起那一行印的那一句：写的时候是末尾那个非空行，落定之后是开头那个非空行。
 *
 * 逐字照抄，不认 markdown —— 滤掉围栏、表格与行内标记，等于让这一格在模型写代码块的
 * 整段时间里停在一句旧话上。两头都从边界往里扫，不分配行表：每来一个 token 问一次。
 */

/** 从哪一头读。 */
export type ThoughtEdge = 'head' | 'tail'

export function readThoughtLine(text: string, edge: ThoughtEdge): string {
  return edge === 'head' ? headLine(text) : tailLine(text)
}

function headLine(text: string): string {
  let from = 0

  for (;;) {
    const end = text.indexOf('\n', from)
    const line = text.slice(from, end < 0 ? text.length : end).trim()

    if (line !== '') {
      return line
    }

    if (end < 0) {
      return ''
    }

    from = end + 1
  }
}

function tailLine(text: string): string {
  let end = text.length

  while (end > 0) {
    const from = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(from, end).trim()

    if (line !== '') {
      return line
    }

    end = from - 1
  }

  return ''
}
