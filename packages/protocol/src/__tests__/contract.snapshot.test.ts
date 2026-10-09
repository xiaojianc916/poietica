import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { contractSnapshot } from '@poietica/contract-kit'
import { appContract, ownerOf, PROTOCOL_VERSION } from '../index'

const file = path.join(import.meta.dir, 'contract.snapshot.json')

describe('T-PROTO-SNAPSHOT', () => {
  test('契约快照与代码一致（不一致时运行 bun run protocol:snapshot）', () => {
    const expected = readFileSync(file, 'utf8')
    const actual = contractSnapshot(appContract)
    if (actual !== expected) {
      throw new Error(
        '契约变了：请提升 PROTOCOL_VERSION（任何契约形状变化都要提升）并运行 bun run protocol:snapshot 更新快照。',
      )
    }
    expect(actual).toBe(expected)
  })

  test('PROTOCOL_VERSION 是正整数', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true)
    expect(PROTOCOL_VERSION).toBeGreaterThan(0)
  })

  test('system 契约已在 appContract 中', () => {
    expect(appContract.contracts.map((c) => c.id)).toContain('system')
    expect(appContract.methods.has('core.shutdown')).toBe(true)
    expect(appContract.notifications.has('core.ready')).toBe(true)
  })

  test('ownerOf 按方法或通知查 owner，查不到返回 undefined（05 §8）', () => {
    expect(ownerOf('turns.submit')).toBe('core')
    expect(ownerOf('app.info')).toBe('host')
    expect(ownerOf('core.ready')).toBe('core')
    expect(ownerOf('nope.nope')).toBeUndefined()
  })
})
