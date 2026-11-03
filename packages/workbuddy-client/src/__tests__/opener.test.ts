import { describe, expect, test } from 'bun:test'
import { _internal } from '../plugin/workbuddy'

/* OPENERS 认的形状：agent 的自述句 + 「powered by / running on / …」这类连接词。
 * 这几种都是真实措辞会出现的变体，逐字换着试，确认规则对它们一致。 */
const OPENINGS = [
  'You are an AI agent powered by Oh My Pi.',
  'You are a coding assistant running on Oh My Pi.',
  'You are the release agent built on Oh My Pi.',
  'You are an assistant based on some other harness.',
]

/* 不该被动的两种：连接词对不上（bot / 句号结尾）。 */
const UNTOUCHED = ['You are a helpful assistant.', 'You are the best bot ever built on Oh My Pi.']

function body(opening: string): string {
  return JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: `${opening}\n\nSecond paragraph, no opener here.` },
      { role: 'user', content: 'hi' },
    ],
  })
}

describe('OPENERS 的逗号：预置之后同一段文本只有一种形态', () => {
  test('opened() 幂等：opened(opened(x)) === opened(x)', () => {
    for (const line of OPENINGS) {
      const once = _internal.opened(line)
      expect(once).not.toBe(line) // 这几种措辞本来就是要被加逗号的
      expect(_internal.opened(once)).toBe(once)
    }
  })

  test('不该动的文本一个字节都不动', () => {
    for (const line of UNTOUCHED) expect(_internal.opened(line)).toBe(line)
  })

  test('带 opener 的 system 在第一次 withSystem 时就已是逗号形态', () => {
    const line = OPENINGS[0] as string
    const first = _internal.withSystem(body(line)) as string
    expect(first).toContain('You are an AI agent, powered by Oh My Pi.')
    /* 第二次跑同样的 body 不再变化 —— 第一轮就是终态，不必被拒一次才学到 */
    expect(_internal.withSystem(first)).toBe(first)
  })

  test('预置路径与 400 兜底路径产出同一串字节', () => {
    for (const line of OPENINGS) {
      const raw = body(line)
      /* 预置：prepare 每次都跑的 withSystem */
      const preset = _internal.withSystem(raw) as string
      /* 兜底：commaPaused 仍是「OPENERS 没覆盖到的新措辞」那条阶梯 */
      const fallback = _internal.commaPaused(raw, new Set()) as string
      expect(preset).toBe(fallback)
      /* 兜底拿到已经定形的 body 时不再变化，否则两条路径会互相打架、每轮变一次 */
      expect(_internal.commaPaused(preset, new Set())).toBeNull()
    }
  })

  test('已经是逗号形态的文本不会被预置与兜底来回改写', () => {
    for (const line of OPENINGS) {
      const settled = _internal.opened(line)
      const raw = body(settled)
      expect(_internal.withSystem(raw)).toBe(raw)
      expect(_internal.commaPaused(raw, new Set())).toBeNull()
    }
  })

  test('assistant 消息里的同一句也按同一套规则定形', () => {
    const line = OPENINGS[1] as string
    const raw = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'who are you?' },
        { role: 'assistant', content: line },
      ],
    })
    const once = _internal.withSystem(raw) as string
    expect(once).toContain('You are a coding assistant, running on Oh My Pi.')
    expect(_internal.withSystem(once)).toBe(once)
  })

  test('用户自己说的话不被加逗号（PAUSED_ROLES 只认 system / assistant）', () => {
    const line = OPENINGS[0] as string
    const raw = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: line },
      ],
    })
    expect(_internal.withSystem(raw)).toBe(raw)
  })
})
