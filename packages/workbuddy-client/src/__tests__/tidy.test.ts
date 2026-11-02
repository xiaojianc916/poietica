import { describe, expect, test } from 'bun:test'
import { _internal } from '../plugin/workbuddy'

/* copilot.tencent.com 的真实形状（magpie 的 workbuddy_blocks_test.go）：每个 delta 都带
 * "tool_calls": []，思考结束后还带空 reasoning_content，未终结帧的 finish_reason 是空串。
 * Chat 契约里这四样都不该出现。 */
function chunk(delta: string, finish: string): string {
  return (
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":' +
    delta +
    ',"finish_reason":' +
    finish +
    '}]}'
  )
}

/* 测试环境里 happy-dom 换掉了 ReadableStream / TransformStream（pipeThrough 直接抛），
 * 所以这里逐行验 tidyLine —— 它正是流里每一行走的那一步。整条流的行为在真机上由同一个函数决定。 */
const LINES = [
  chunk('{"role":"assistant","content":"","reasoning_content":"Look first.","tool_calls":[]}', '""'),
  chunk('{"content":"我来","reasoning_content":"","tool_calls":[]}', '""'),
  chunk('{"content":"看","reasoning_content":"","tool_calls":[]}', '""'),
  chunk('{"content":"一下","reasoning_content":"","tool_calls":[]}', '""'),
  chunk('{"content":"。","reasoning_content":"","tool_calls":[]}', '""'),
  chunk('{"content":"","reasoning_content":"","tool_calls":[]}', '"stop"'),
  'data: [DONE]',
]

describe('WorkBuddy 流的 Chat 契约修缮（对应 magpie 的 chattidy）', () => {
  test('空的 tool_calls / reasoning_content 与空 finish_reason 都被摘掉或改成 null', () => {
    const out = LINES.map(_internal.tidyLine).join('\n')
    expect(out).not.toContain('"tool_calls":[]')
    expect(out).not.toContain('"reasoning_content":""')
    expect(out).not.toContain('"finish_reason":""')
    /* 正文、思考、收尾与结束标记一个都不能少 */
    for (const said of ['"content":"我来"', '"content":"看"', '"content":"一下"', '"content":"。"']) {
      expect(out).toContain(said)
    }
    expect(out).toContain('"reasoning_content":"Look first."')
    expect(out).toContain('"finish_reason":"stop"')
    expect(out).toContain('data: [DONE]')
  })

  test('没要改的行原样返回，不重建 JSON', () => {
    const line = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}'
    expect(_internal.tidyLine(line)).toBe(line)
    /* 不是 data 行、不是 JSON、以及 [DONE] 都原样过 */
    expect(_internal.tidyLine(': keepalive')).toBe(': keepalive')
    expect(_internal.tidyLine('data: not json')).toBe('data: not json')
    expect(_internal.tidyLine('data: [DONE]')).toBe('data: [DONE]')
  })

  test('工具调用本身原样留着', () => {
    const v = {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'grep', arguments: '' } }] } },
      ],
    }
    expect(_internal.tidyChunk(v)).toBe(false)
    expect(v.choices[0]?.delta.tool_calls).toHaveLength(1)
  })

  test('纯文本回复末帧那个空的 legacy function_call 被摘掉', () => {
    const v = {
      choices: [
        { index: 0, delta: { content: '' }, finish_reason: 'stop' },
        { index: 0, delta: { function_call: { name: '', arguments: '' } } },
      ],
    }
    expect(_internal.tidyChunk(v)).toBe(true)
    const second = v.choices[1]?.delta as { function_call?: unknown } | undefined
    expect(second?.function_call).toBeUndefined()
  })

  test('非 SSE 也非 JSON 的答复原样交回，不重建流', async () => {
    const res = new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } })
    expect(await _internal.tidied(res)).toBe(res)
  })
})
