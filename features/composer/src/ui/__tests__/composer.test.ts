import { describe, expect, test } from 'bun:test'
import { type ComposerStore, createComposerStore } from '../composer-store'
import { projectDocument, textDocument } from '../draft-document'

const textOf = (store: ComposerStore, threadId: string | null): string =>
  projectDocument(store.draft(threadId).document).text

describe('草稿 store（uiState 的 conversation.drafts，编辑器文档为唯一事实）', () => {
  test('每个线程一份草稿；home 用单独的键', () => {
    const store = createComposerStore()
    store.setText('t1', '第一条')
    store.setText(null, '首页草稿')
    expect(textOf(store, 't1')).toBe('第一条')
    expect(textOf(store, null)).toBe('首页草稿')
    expect(textOf(store, 't2')).toBe('')
  })

  test('附件累加、可删；正文与附件互不影响', () => {
    const store = createComposerStore()
    store.setText('t1', '正文')
    store.addAttachments('t1', [{ id: 'a', name: 'a.png', kind: 'image', previewUrl: null }])
    store.addAttachments('t1', [{ id: 'b', name: 'b.txt', kind: 'file', previewUrl: null }])
    expect(store.draft('t1').assets.map((a) => a.assetToken)).toEqual(['a', 'b'])
    store.removeAttachment('t1', 'a')
    expect(store.draft('t1').assets.map((a) => a.assetToken)).toEqual(['b'])
    expect(textOf(store, 't1')).toBe('正文')
  })

  test('insertText 追加进同一份文档', () => {
    const store = createComposerStore()
    store.setText('t1', '第一句')
    store.insertText('t1', '第二句')
    expect(textOf(store, 't1')).toBe('第一句 第二句')
  })

  test('clear 之后回到空草稿；restore 能把文档与附件放回去（提交失败的回滚）', () => {
    const store = createComposerStore()
    store.setText('t1', '正文')
    store.addAttachments('t1', [{ id: 'a', name: 'a.png', kind: 'image', previewUrl: null }])
    const held = store.draft('t1')
    store.clear('t1')
    expect(store.draft('t1').document).toBeUndefined()
    expect(store.draft('t1').assets).toEqual([])
    store.restore('t1', held)
    expect(textOf(store, 't1')).toBe('正文')
    expect(store.draft('t1').assets.map((a) => a.assetToken)).toEqual(['a'])
  })

  test('snapshot 只留非空草稿（持久化用）', () => {
    const store = createComposerStore()
    store.setText('t1', '有内容')
    store.setText('t2', '   ')
    const snap = store.snapshot()
    expect(Object.keys(snap)).toEqual(['t1'])
  })

  test('初始草稿从 uiState 恢复（编辑器文档 + 附件）', () => {
    const store = createComposerStore({
      t9: {
        document: textDocument('恢复的草稿'),
        assets: [],
        configuration: [],
      },
    })
    expect(textOf(store, 't9')).toBe('恢复的草稿')
  })

  /*
   * Core 回报哪些附件已经不存在时，从**所有**草稿里一并清掉它们。
   * 判据两条：命中的都删、其它内容原样；一个都没命中时不换引用（订阅者不白重画）。
   */
  test('R-07 T8 dropAttachments 跨草稿移除，正文与其它附件不动', () => {
    const store = createComposerStore()
    store.setText('t1', '第一格')
    store.addAttachments('t1', [
      { id: 'x', name: 'x.png', kind: 'image', previewUrl: null },
      { id: 'y', name: 'y.png', kind: 'image', previewUrl: null },
    ])
    store.addAttachments(null, [{ id: 'x', name: 'x.png', kind: 'image', previewUrl: null }])

    expect(store.dropAttachments(['x'])).toBe(2)
    expect(store.draft('t1').assets.map((a) => a.assetToken)).toEqual(['y'])
    expect(textOf(store, 't1')).toBe('第一格')
    expect(store.draft(null).assets).toEqual([])

    /* 没有命中：返回 0，而且不换引用（同一份 drafts 对象） */
    const before = store.store.getState().drafts
    expect(store.dropAttachments(['nope'])).toBe(0)
    expect(store.store.getState().drafts).toBe(before)
  })

  test('entryReady：起始为 false，markEntryReady 只翻一次（重复调用不换状态引用）', () => {
    const store = createComposerStore()
    expect(store.store.getState().entryReady).toBe(false)
    store.markEntryReady()
    const after = store.store.getState()
    expect(after.entryReady).toBe(true)
    store.markEntryReady()
    expect(store.store.getState()).toBe(after)
  })
})
