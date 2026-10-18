import { describe, expect, test } from 'bun:test'
import { withRelayToken } from '../relay-token'

const TOKEN = 'cd'.repeat(32)
const ENV = { POIETICA_RELAY_TOKEN_FILE: '/data/core/relay.token' }

describe('withRelayToken', () => {
  test('RT-C1 Host 拉起的进程：读口令文件，补上 --token（omp 的 browser-relay 已支持这个参数）', () => {
    const read = (file: string): string => {
      expect(file).toBe('/data/core/relay.token')
      return `${TOKEN}\n`
    }
    expect(withRelayToken(['browser-relay', '--port', '4321'], ENV, read)).toEqual([
      'browser-relay',
      '--port',
      '4321',
      '--token',
      TOKEN,
    ])
  })

  test('RT-C2 参数里已有 --token：手工指定优先，不读文件', () => {
    const read = (): string => {
      throw new Error('不该读')
    }
    expect(withRelayToken(['browser-relay', '--token', 'x'], ENV, read)).toEqual(['browser-relay', '--token', 'x'])
    expect(withRelayToken(['browser-relay', '--token=x'], ENV, read)).toEqual(['browser-relay', '--token=x'])
  })

  test('RT-C3 环境里没有口令文件路径（不是 Host 派生的）：保持 omp 默认', () => {
    expect(withRelayToken(['browser-relay', '--port', '1'], {}, () => TOKEN)).toEqual(['browser-relay', '--port', '1'])
  })

  test('RT-C4 有路径但读不到或格式不对：抛错（调用方拒绝启动，不敞开 /ext）', () => {
    const missing = (): string => {
      throw new Error('ENOENT')
    }
    expect(() => withRelayToken(['browser-relay'], ENV, missing)).toThrow(/读不到 relay 口令文件/)
    expect(() => withRelayToken(['browser-relay'], ENV, () => 'short')).toThrow(/格式不对/)
  })
})
