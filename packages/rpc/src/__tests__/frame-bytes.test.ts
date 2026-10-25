import { describe, expect, test } from 'bun:test'
import { encodeFrame, jsonValue, RawJson } from '../frame'
import { FrameByteDecoder } from '../frame-bytes'
import type { NotificationMessage, RpcMessage, SuccessMessage } from '../messages'

const utf8 = new TextEncoder()

function collector(maxFrameBytes?: number) {
  const messages: RpcMessage[] = []
  const strays: string[] = []
  const decoder = new FrameByteDecoder(
    (m) => messages.push(m),
    (t) => strays.push(t),
    maxFrameBytes,
  )
  return { decoder, messages, strays }
}

const note = (params: unknown): RpcMessage => ({ jsonrpc: '2.0', method: 'timeline.ops', params })

describe('FrameByteDecoder（Host 读 Core stdout）', () => {
  test('载荷留成 RawJson：字节与 Core 写出的完全一致，取值才解析', () => {
    const { decoder, messages } = collector()
    const params = { text: '中文\u2028正文 \u001f 与 \\n', n: 1 }
    decoder.push(utf8.encode(encodeFrame(note(params))))
    expect(messages).toHaveLength(1)
    const got = messages[0] as NotificationMessage
    expect(got.method).toBe('timeline.ops')
    expect(got.params).toBeInstanceOf(RawJson)
    expect((got.params as RawJson).text).toBe(JSON.stringify(params))
    expect(jsonValue(got.params)).toEqual(params)
  })

  test('一帧在任意字节处被切开（含多字节 UTF-8 字符中间）都能还原', () => {
    const frame = utf8.encode(encodeFrame({ jsonrpc: '2.0', id: 9, result: { s: '汉字🙂é' } }))
    for (let cut = 1; cut < frame.length; cut++) {
      const { decoder, messages, strays } = collector()
      decoder.push(frame.subarray(0, cut))
      decoder.push(frame.subarray(cut))
      expect(strays).toEqual([])
      expect(messages).toHaveLength(1)
      expect((messages[0] as SuccessMessage).id).toBe(9)
      expect(jsonValue((messages[0] as SuccessMessage).result)).toEqual({ s: '汉字🙂é' })
    }
  })

  test('同一块里多帧、\\r\\n 结尾、空白行、字符串 chunk', () => {
    const { decoder, messages, strays } = collector()
    decoder.push(
      utf8.encode(`${encodeFrame(note({ a: 1 }))}\n  \n${encodeFrame(note({ a: 2 })).replace('\n', '\r\n')}`),
    )
    decoder.push(encodeFrame(note({ a: 3 })))
    expect(strays).toEqual([])
    expect(messages.map((m) => jsonValue((m as NotificationMessage).params))).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  test('不带分隔符的帧（没有载荷的消息）全量解析', () => {
    const { decoder, messages } = collector()
    const error: RpcMessage = {
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32000, message: 'x', data: { code: 'a.b', message: 'x' } },
    }
    decoder.push(utf8.encode(`\x1e${JSON.stringify(error)}\n\x1e${JSON.stringify(note({ old: true }))}\n`))
    expect(messages).toEqual([error, note({ old: true })])
  })

  test('杂散输出：前缀之前的文本、不带前缀的行交给 onStray；坏信封与非 JSON-RPC 各报一次', () => {
    const { decoder, messages, strays } = collector()
    decoder.push(utf8.encode(`native noise\nabc${encodeFrame(note({ ok: 1 }))}\x1e{oops\x1f{}\n\x1e{"a":1}\x1f{}\n`))
    expect(strays).toEqual(['native noise', 'abc', '[bad frame] {oops\x1f{}', '[not jsonrpc] {"a":1}\x1f{}'])
    expect(messages).toHaveLength(1)
  })

  test('超长帧报一次 [frame overflow] 并丢弃到下一个换行，之后的帧照常', () => {
    const { decoder, messages, strays } = collector(256)
    const huge = utf8.encode(encodeFrame(note({ text: 'z'.repeat(1000) })))
    decoder.push(huge.subarray(0, 100))
    decoder.push(huge.subarray(100, 600))
    decoder.push(huge.subarray(600))
    decoder.push(utf8.encode(encodeFrame(note({ after: 1 }))))
    expect(strays).toHaveLength(1)
    expect(strays[0]?.startsWith('[frame overflow] \x1e{"jsonrpc"')).toBe(true)
    expect(messages.map((m) => jsonValue((m as NotificationMessage).params))).toEqual([{ after: 1 }])
  })

  test('任意切块与整块推入解出的消息完全一致、杂散报告一一对应（大帧逐块解码、杂散、坏帧、旧帧、\\r\\n、空白行混在一起）', () => {
    const big = { text: `${'汉字🙂é'.repeat(3000)}${'ascii '.repeat(2000)}`, list: [1, 2, 3] }
    const stream = utf8.encode(
      [
        encodeFrame(note(big)),
        `noise before ${encodeFrame({ jsonrpc: '2.0', id: 1, result: big })}`,
        '   \n',
        `\x1e{oops\x1f${'x'.repeat(5000)}\n`,
        `\x1e{"a":1}\x1f${JSON.stringify(big)}\n`,
        `\x1e${JSON.stringify(note({ old: big.text.slice(0, 500) }))}\n`,
        encodeFrame(note({ crlf: '中' })).replace('\n', '\r\n'),
        encodeFrame(note(big)).replace('\n', '\r\n'),
        'plain stray line\n',
        encodeFrame({
          jsonrpc: '2.0',
          id: 2,
          error: { code: -1, message: '错', data: { code: 'a.b', message: '错' } },
        }),
      ].join(''),
    )
    const run = (cuts: readonly number[]) => {
      const { decoder, messages, strays } = collector()
      let at = 0
      for (const cut of [...cuts, stream.length]) {
        decoder.push(stream.subarray(at, cut))
        at = cut
      }
      return {
        messages: messages.map((m) => JSON.parse(JSON.stringify(m)) as unknown),
        strays,
      }
    }
    const whole = run([])
    const first200 = (text: string): string => new TextDecoder().decode(utf8.encode(text).subarray(0, 200))
    expect(whole.messages).toHaveLength(6)
    expect(whole.strays).toEqual([
      'noise before ',
      `[bad frame] {oops\x1f${'x'.repeat(194)}`,
      `[not jsonrpc] ${first200(`{"a":1}\x1f${JSON.stringify(big)}`)}`,
      'plain stray line',
    ])
    let seed = 7
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let trial = 0; trial < 40; trial++) {
      const cuts: number[] = []
      for (let at = random(4096) + 1; at < stream.length; at += random(trial < 20 ? 64 : 9000) + 1) cuts.push(at)
      const got = run(cuts)
      expect(got.messages).toEqual(whole.messages)
      /* 诊断样本取自当时手上的字节（跨块大帧在信封到达时就报），所以只比较标签与开头 */
      expect(got.strays.map((t) => t.slice(0, 18))).toEqual(whole.strays.map((t) => t.slice(0, 18)))
    }
  })

  test('载荷态里的超长与坏信封：各报一次，丢弃到行尾，之后照常', () => {
    const { decoder, messages, strays } = collector(1024)
    const huge = utf8.encode(encodeFrame(note({ text: '字'.repeat(2000) })))
    decoder.push(huge.subarray(0, 300)) // 信封已到：进入载荷态
    decoder.push(huge.subarray(300, 900))
    decoder.push(huge.subarray(900, 1500)) // 超长
    decoder.push(huge.subarray(1500))
    decoder.push(utf8.encode('\x1e{bad'))
    decoder.push(utf8.encode(`\x1f${'y'.repeat(50)}`))
    decoder.push(utf8.encode(`${'y'.repeat(50)}\n${encodeFrame(note({ after: 1 }))}`))
    expect(strays).toHaveLength(2)
    expect(strays[0]?.startsWith('[frame overflow] \x1e{"jsonrpc":"2.0","method":"timeline.ops"}\x1f{"text":"字')).toBe(
      true,
    )
    expect(strays[1]).toBe(`[bad frame] {bad\x1f${'y'.repeat(50)}`)
    expect(messages.map((m) => jsonValue((m as NotificationMessage).params))).toEqual([{ after: 1 }])
  })

  test('大帧按 64KB 分片推入是线性时间：8MB 与 32MB 的耗时比远小于平方增长', () => {
    const timeFor = (chars: number): number => {
      const frame = utf8.encode(encodeFrame({ jsonrpc: '2.0', id: 1, result: { text: '字'.repeat(chars) } }))
      let got = 0
      const decoder = new FrameByteDecoder(
        () => {
          got += 1
        },
        () => undefined,
      )
      const started = performance.now()
      for (let i = 0; i < frame.length; i += 64 * 1024) decoder.push(frame.subarray(i, i + 64 * 1024))
      const elapsed = performance.now() - started
      expect(got).toBe(1)
      return elapsed
    }
    timeFor(1024 * 1024) // 预热
    const small = timeFor(8 * 1024 * 1024)
    const large = timeFor(32 * 1024 * 1024)
    expect(large).toBeLessThan(Math.max(small, 5) * 10)
  })
})
