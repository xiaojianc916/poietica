import { describe, expect, test } from 'bun:test'
import { RawJson, relayParts } from '../frame'
import type { RpcMessage } from '../messages'
import { type PreloadBridge, windowBridgeFromPreload } from '../window-bridge'

function fakePreload() {
  const listeners = new Set<(m: unknown, payloadJson?: string) => void>()
  const sent: RpcMessage[] = []
  const preload: PreloadBridge = {
    send: (m) => sent.push(m),
    onMessage: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    pathForFile: () => 'C:\\a.txt',
  }
  const emit = (m: unknown, payloadJson?: string): void => {
    for (const l of [...listeners]) l(m, payloadJson)
  }
  return { preload, sent, emit }
}

describe('windowBridgeFromPreload（页面一侧）', () => {
  test('Host 转交的「信封 + 载荷 JSON 文本」→ 页面解析出与 Core 发出时相同的消息', () => {
    const { preload, emit } = fakePreload()
    const got: RpcMessage[] = []
    windowBridgeFromPreload(preload).onMessage((m) => got.push(m))
    const params = { ops: [{ op: 'frame.append', text: '中文\u2028' }] }
    const raw = new RawJson(JSON.stringify(params))
    const [envelope, payloadJson] = relayParts({ jsonrpc: '2.0', method: 'timeline.ops', params: raw })!
    emit(envelope, payloadJson) // ipc-transport → preload → 页面

    expect(got).toEqual([{ jsonrpc: '2.0', method: 'timeline.ops', params }])
  })

  test('Host 自己发的对象原样交付；坏消息丢弃并报告；send / pathForFile 直通；退订生效', () => {
    const { preload, sent, emit } = fakePreload()
    const got: RpcMessage[] = []
    const bad: string[] = []
    const bridge = windowBridgeFromPreload(preload, (s) => bad.push(s))
    const off = bridge.onMessage((m) => got.push(m))
    const status: RpcMessage = { jsonrpc: '2.0', method: 'core.status', params: { state: 'ready' } }
    emit(status)
    emit({ jsonrpc: '2.0', id: 1 }, '{oops')
    emit({ hello: 1 })
    emit({ hello: 1 }, '{}')
    expect(got).toEqual([status])
    expect(bad).toEqual(['[bad] {oops', '[not jsonrpc] (object)', '[not-jsonrpc] {}'])
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'a.b', params: {} })
    expect(sent).toHaveLength(1)
    expect(bridge.pathForFile({})).toBe('C:\\a.txt')
    off()
    emit(status)
    expect(got).toHaveLength(1)
  })
})
