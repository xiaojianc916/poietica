/*
 * 一段还在写的推理写到哪一句了：末尾那个非空行，和它在原文里的行号。
 *
 * 行号是这一格的身份（zcode-ref 的 reasoning.tsx 用 `reasoning-line:<行号>` 当 key）：
 * 同一行继续往下写是**原地刷新**，换行才是**换了一格**、才播一次滚动。少了这个身份，
 * 每个 token 都会被当成换格，动画从头到尾没停过 —— 那就不是「正在写」，是「一直在翻页」。
 *
 * 逐字照抄，不认 markdown：滤掉围栏与标记，等于让这一格在模型写代码块的整段时间里停在
 * 一句旧话上。从末尾往里扫，不分配行表 —— 每来一个 token 问一次。整段还没有非空行时
 * 交出空串的 key：它和任何一行都不同，于是第一行落下时正好滚一次。
 */

export interface ThoughtLine {
  /** 这句话在原文里的行号；一个字都还没有时是空串。 */
  readonly key: string
  readonly text: string
}

export function readThoughtLine(text: string): ThoughtLine {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''

    if (line !== '') {
      return { key: String(index), text: line }
    }
  }

  return { key: '', text: '' }
}
