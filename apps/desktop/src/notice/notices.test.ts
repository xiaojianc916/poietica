import { describe, expect, it } from 'bun:test'
import { FailureCoordinator } from '@poietica/problem'
import { NoticeStore, noticeDwellMs } from './notices'

describe('屏幕上的失败通知', () => {
  it('只收错误级：降级的功能不弹卡片', () => {
    const coordinator = new FailureCoordinator()
    const store = new NoticeStore(coordinator)
    const stop = store.start()
    coordinator.report({
      impact: 'feature-degraded',
      code: 'SETTINGS_UNAVAILABLE',
      userMessage: '设置暂时不可用。',
      cause: new Error('settings'),
      scope: { kind: 'feature', featureId: 'settings' },
      recovery: 'disable-feature',
    })
    expect(store.getSnapshot()).toHaveLength(0)
    coordinator.report({
      impact: 'recoverable',
      code: 'SAVE_FAILED',
      userMessage: '保存失败。',
      cause: new Error('disk'),
      scope: { kind: 'operation', operation: 'save' },
      recovery: 'retry',
    })
    expect(store.getSnapshot()).toHaveLength(1)
    expect(store.getSnapshot()[0]?.title).toBe('保存失败。')
    expect(store.getSnapshot()[0]?.detail).toBe('disk')
    stop()
  })
  it('最多同时在场三张，更旧的那张转入退场', () => {
    const coordinator = new FailureCoordinator()
    const store = new NoticeStore(coordinator)
    const stop = store.start()
    for (const code of ['SAVE_A', 'SAVE_B', 'SAVE_C', 'SAVE_D']) {
      coordinator.report({
        impact: 'recoverable',
        code,
        userMessage: '保存失败。',
        cause: new Error('disk'),
        scope: { kind: 'operation', operation: 'save' },
        recovery: 'retry',
      })
    }
    expect(store.getSnapshot().filter((notice) => !notice.closing)).toHaveLength(3)
    expect(store.getSnapshot().filter((notice) => notice.closing)).toHaveLength(1)
    stop()
  })
  it('停留时间跟着字数走，两头收口', () => {
    expect(noticeDwellMs('短', undefined)).toBe(4_090)
    expect(noticeDwellMs('保存失败。', '磁盘满了')).toBe(4_810)
    expect(noticeDwellMs('。'.repeat(400), undefined)).toBe(12_000)
  })
})
