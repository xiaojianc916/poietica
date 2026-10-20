import { describe, expect, test } from 'bun:test'
import type { ComposerDraft } from '../../../ui-api'
import { createLiveComposers } from '../live-composers'

const draft = (threadId: string): ComposerDraft => ({
  threadId,
  addAttachments: () => undefined,
  insertText: () => undefined,
  submit: () => undefined,
})

describe('屏幕上的对话输入框登记表', () => {
  test('后登记的覆盖先登记的；先卸载的旧格注销不掉后来的那一格', () => {
    const live = createLiveComposers()
    const first = draft('t1')
    const second = draft('t1')
    const offFirst = live.register('t1', first)
    const offSecond = live.register('t1', second)
    expect(live.get('t1')).toBe(second)
    offFirst()
    expect(live.get('t1')).toBe(second)
    offSecond()
    expect(live.get('t1')).toBeUndefined()
  })
})
