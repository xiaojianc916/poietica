import { describe, expect, test } from 'bun:test'
import { READ_ONLY_TEXT, readOnlyReason } from '../data-read-only-notice'

describe('入口提示：数据只读（ADR-004）', () => {
  test('可写不占位；只读按来路给一句话', () => {
    expect(readOnlyReason({ mode: 'readWrite' })).toBeNull()
    expect(readOnlyReason({ mode: 'readOnly', reason: 'data_too_new' })).toBe('data_too_new')
    expect(readOnlyReason({ mode: 'readOnly', reason: 'migration_failed' })).toBe('migration_failed')
    expect(READ_ONLY_TEXT.data_too_new).toContain('只读')
    expect(READ_ONLY_TEXT.migration_failed).toContain('只读')
  })
})
