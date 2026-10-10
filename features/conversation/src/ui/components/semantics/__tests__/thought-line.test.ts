import { describe, expect, it } from 'bun:test'
import { readThoughtLine } from '../thought-line'

/*
 * 组头那一格取的是哪一句话。
 *
 * 要紧的是 key 的语义：同一行继续往下写，key 不变 —— 于是组头原地刷新，不播滚动；
 * 换行才换 key，才翻一格。少了这条区分，每个 token 都会被当成换格，动画从头到尾没停过。
 */

describe('推理取末行的规则', () => {
  it('取末尾那个非空行，key 是它的行号', () => {
    expect(readThoughtLine('第一行\n第二行')).toEqual({ key: '1', text: '第二行' })
  })

  it('同一行继续写：key 不变，只有字变', () => {
    const first = readThoughtLine('第一行\n正在')
    const more = readThoughtLine('第一行\n正在读配置')

    expect(more.key).toBe(first.key)
    expect(more.text).not.toBe(first.text)
  })

  it('换行才换 key：这才是「翻了一格」', () => {
    expect(readThoughtLine('第一行\n第二行').key).not.toBe(readThoughtLine('第一行\n第二行\n第三').key)
  })

  it('末尾空行不算一行，也不把 key 挪走', () => {
    expect(readThoughtLine('第一行\n第二行\n')).toEqual({ key: '1', text: '第二行' })
    expect(readThoughtLine('第一行\n第二行\n\n')).toEqual({ key: '1', text: '第二行' })
  })

  it('整段还是空白时交出空 key：第一句话落下正好翻一次', () => {
    expect(readThoughtLine('')).toEqual({ key: '', text: '' })
    expect(readThoughtLine('\n  \n')).toEqual({ key: '', text: '' })
  })

  it('CRLF 与多段正文按同一套行号数', () => {
    expect(readThoughtLine('第一行\r\n第二行\r\n')).toEqual({ key: '1', text: '第二行' })
  })
})
