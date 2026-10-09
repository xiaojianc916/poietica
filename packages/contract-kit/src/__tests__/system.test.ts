import { describe, expect, test } from 'bun:test'
import { SystemErrorCode } from '@poietica/foundation'
import { coreStatusSchema, systemErrors } from '../system'

describe('system 契约', () => {
  test('SystemErrorCode 与 systemErrors.__messages 的键一一对应', () => {
    expect([...Object.values(SystemErrorCode)].map(String).sort()).toEqual(Object.keys(systemErrors.__messages).sort())
  })

  test('coreStatusSchema 拒绝未知的 reason', () => {
    expect(coreStatusSchema.safeParse({ state: 'ready', reason: 'oops', attempt: 0 }).success).toBe(false)
    expect(coreStatusSchema.safeParse({ state: 'ready', reason: null, attempt: 0 }).success).toBe(true)
  })
})
