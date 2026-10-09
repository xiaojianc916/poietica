import { describe, expect, test } from 'bun:test'
import { stderrJsonSink } from '../stderr-sink'

describe('stderrJsonSink', () => {
  test('写入一行 JSON 且以 \n 结尾', () => {
    const chunks: string[] = []
    const sink = stderrJsonSink({
      write(text: string) {
        chunks.push(text)
        return true
      },
    })
    sink.write({ ts: 1, level: 'info', msg: 'a' })
    expect(chunks).toHaveLength(1)
    const line = chunks[0] ?? ''
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ ts: 1, level: 'info', msg: 'a' })
  })

  test('stream 抛错时 write 不抛', () => {
    const sink = stderrJsonSink({
      write() {
        throw new Error('stderr closed')
      },
    })
    expect(() => {
      sink.write({ ts: 1, level: 'info', msg: 'a' })
    }).not.toThrow()
  })
})
