import { describe, expect, test } from 'bun:test'
import { createComposerStore } from '../composer'

describe('草稿 store（07 页 §5E：草稿持久化到 uiState 的 conversation.drafts）', () => {
  test('每个线程一份草稿；home 用单独的键', () => {
    const store = createComposerStore()
    store.setText('t1', '第一条')
    store.setText(null, '首页草稿')
    expect(store.draft('t1').text).toBe('第一条')
    expect(store.draft(null).text).toBe('首页草稿')
    expect(store.draft('t2').text).toBe('')
  })

  test('附件与技能各自累加、可删', () => {
    const store = createComposerStore()
    store.addAttachments('t1', [{ id: 'a', name: 'a.png', kind: 'image', previewUrl: null }])
    store.addAttachments('t1', [{ id: 'b', name: 'b.txt', kind: 'file', previewUrl: null }])
    expect(store.draft('t1').attachments.map((a) => a.id)).toEqual(['a', 'b'])
    store.removeAttachment('t1', 'a')
    expect(store.draft('t1').attachments.map((a) => a.id)).toEqual(['b'])
    store.addSkill('t1', 's1')
    store.addSkill('t1', 's1')
    expect(store.draft('t1').skills).toEqual(['s1'])
  })

  test('clear 之后回到空草稿；restore 能把内容放回去（提交失败的回滚）', () => {
    const store = createComposerStore()
    store.setText('t1', '正文')
    const held = store.draft('t1')
    store.clear('t1')
    expect(store.draft('t1').text).toBe('')
    store.restore('t1', held)
    expect(store.draft('t1').text).toBe('正文')
  })

  test('snapshot 只留非空草稿（持久化用）', () => {
    const store = createComposerStore()
    store.setText('t1', '有内容')
    store.setText('t2', '   ')
    const snap = store.snapshot()
    expect(Object.keys(snap)).toEqual(['t1'])
  })

  test('初始草稿从 uiState 恢复', () => {
    const store = createComposerStore({ t9: { text: '恢复的草稿', attachments: [], skills: [] } })
    expect(store.draft('t9').text).toBe('恢复的草稿')
  })

  /*
   * R-07 T8：Core 回报哪些附件已经不存在时，从**所有**草稿里一并清掉它们。
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
    expect(store.draft('t1').attachments.map((a) => a.id)).toEqual(['y'])
    expect(store.draft('t1').text).toBe('第一格')
    expect(store.draft(null).attachments).toEqual([])

    /* 没有命中：返回 0，而且不换引用（同一份 drafts 对象） */
    const before = store.store.getState().drafts
    expect(store.dropAttachments(['nope'])).toBe(0)
    expect(store.store.getState().drafts).toBe(before)
  })
})
