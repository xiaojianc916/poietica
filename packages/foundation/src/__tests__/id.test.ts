import { describe, expect, test } from 'bun:test'
import { createId, idTime, isId } from '../id'

describe('createId', () => {
  // 单调状态是模块级的（同一进程里只会前进），所以往返用例必须用一个比“已经铸过的最大值”还大的时间戳；
  // 用一个未来时刻即可，且不依赖本文件内用例的执行顺序。
  test('idTime 还原毫秒时间戳', () => {
    const at = Date.now() + 86_400_000
    expect(idTime(createId(at))).toBe(at)
  })

  test('长度 26 且 isId 为真', () => {
    const id = createId()
    expect(id.length).toBe(26)
    expect(isId(id)).toBe(true)
    expect(isId('nope')).toBe(false)
  })

  test('同一 now 连续生成 1000 个严格递增', () => {
    const ids = Array.from({ length: 1000 }, () => createId(1_700_000_000_000))
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true)
  })

  test('时钟回拨后仍大于前一个', () => {
    const a = createId(5)
    const b = createId(3)
    expect(b > a).toBe(true)
  })

  test('非法时间戳抛 RangeError', () => {
    expect(() => createId(-1)).toThrow(RangeError)
  })
})
