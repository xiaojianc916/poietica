import { describe, expect, test } from 'bun:test'
import { createComposerStore } from '../composer'
import { createDraftPin } from '../draft-pin'

/**
 * R-07 D1–D4：conversation 交出去的那份「草稿里有哪些附件」的只读视图。
 *
 * 这一份视图是 attachments 侧做整体替换的唯一依据，所以两条时序判据要钉死：
 * 恢复前是 null（不是空集合），以及打字不触发通知。
 */
describe('草稿附件视图（R-07 §3.4）', () => {
  test('D1 恢复前 ids() 为 null；恢复后跨草稿去重、升序', () => {
    const composer = createComposerStore()
    composer.addAttachments('t2', [{ id: 'b', name: 'b', kind: 'file', previewUrl: null }])
    composer.addAttachments('t1', [
      { id: 'a', name: 'a', kind: 'image', previewUrl: null },
      { id: 'b', name: 'b', kind: 'file', previewUrl: null },
    ])
    const pin = createDraftPin(composer)

    expect(pin.view.ids()).toBeNull()
    pin.markRestored()
    expect(pin.view.ids()).toEqual(['a', 'b'])
    expect(pin.restored()).toBe(true)
  })

  test('D2 打字不通知；增删附件与恢复各通知一次', () => {
    const composer = createComposerStore()
    const pin = createDraftPin(composer)
    let calls = 0
    pin.view.subscribe(() => {
      calls += 1
    })

    composer.setText('t1', '打')
    pin.onChange()
    composer.setText('t1', '打字')
    pin.onChange()
    expect(calls).toBe(0)

    composer.addAttachments('t1', [{ id: 'a', name: 'a', kind: 'image', previewUrl: null }])
    pin.onChange()
    expect(calls).toBe(1)

    /* 集合没变：不再通知（同一个附件重复 add 也不变） */
    pin.onChange()
    expect(calls).toBe(1)

    composer.removeAttachment('t1', 'a')
    pin.onChange()
    expect(calls).toBe(2)

    pin.markRestored()
    expect(calls).toBe(3)
  })

  test('D3 盘上读到值：hydrate 之后 markRestored，ids 是恢复进来的那一份', () => {
    const composer = createComposerStore()
    const pin = createDraftPin(composer)
    composer.hydrate({
      t9: { text: '旧草稿', attachments: [{ id: 'z', name: 'z', kind: 'file', previewUrl: null }], skills: [] },
    })
    pin.onChange()
    expect(pin.view.ids()).toBeNull()
    pin.markRestored()
    expect(pin.view.ids()).toEqual(['z'])
  })

  test('D4 drop 从所有草稿里移除并返回条数；没有命中时不换引用', () => {
    const composer = createComposerStore()
    composer.addAttachments('t1', [{ id: 'x', name: 'x', kind: 'image', previewUrl: null }])
    composer.setText(null, '入口草稿')
    const pin = createDraftPin(composer)
    pin.markRestored()

    expect(pin.view.drop(['x'])).toBe(1)
    expect(pin.view.ids()).toEqual([])
    expect(composer.draft(null).text).toBe('入口草稿')

    const before = composer.store.getState().drafts
    expect(pin.view.drop(['ghost'])).toBe(0)
    expect(composer.store.getState().drafts).toBe(before)
  })
})
