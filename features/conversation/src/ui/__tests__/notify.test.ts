import { describe, expect, test } from 'bun:test'
import { completionBody, confirmQuit, isTurnSettled, shouldNotify } from '../session/notify'

/*
 * 只测规则，不测 IO —— 发与不发的接线在 index.tsx 的 setup 里。
 */

describe('shouldNotify（窗口聚焦 + 偏好两条件）', () => {
  test('没有焦点且偏好开着 → 发；两者缺一不发', () => {
    expect(shouldNotify(false, true)).toBe(true)
    expect(shouldNotify(true, true)).toBe(false)
    expect(shouldNotify(false, false)).toBe(false)
    expect(shouldNotify(true, false)).toBe(false)
  })
})

describe('completionBody（07 页 §5E：有 error 则运行失败）', () => {
  test('无 error → 已完成', () => {
    expect(completionBody(null)).toBe('已完成')
  })

  test('有 error → 运行失败（错误码不影响这一句）', () => {
    expect(completionBody({ code: 'engine.upstream_error' })).toBe('运行失败')
  })
})

describe('isTurnSettled（一轮结束的判据）', () => {
  test('running / awaiting → idle 才算结束', () => {
    expect(isTurnSettled('running', 'idle')).toBe(true)
    expect(isTurnSettled('awaiting', 'idle')).toBe(true)
  })

  test('首帧的 idle（previous 未知）不是结束', () => {
    expect(isTurnSettled(undefined, 'idle')).toBe(false)
    expect(isTurnSettled('idle', 'idle')).toBe(false)
  })

  test('仍在运行 / 等待的中间状态不是结束', () => {
    expect(isTurnSettled('running', 'running')).toBe(false)
    expect(isTurnSettled('running', 'awaiting')).toBe(false)
    expect(isTurnSettled('awaiting', 'running')).toBe(false)
  })
})

describe('confirmQuit（07 页 §5E 的关闭拦截）', () => {
  test('没有运行中的线程 → 直接放行，不问', async () => {
    const asked: string[] = []
    const dialogs = {
      confirm: async (o: { title: string }) => {
        asked.push(o.title)
        return true
      },
    } as never
    expect(await confirmQuit(dialogs, 0)).toBe(true)
    expect(asked).toEqual([])
  })

  test('有运行中的线程 → 先确认；文案里带个数与「退出将中断」', async () => {
    const seen: { title: string; body: string; confirmLabel: string; danger: boolean }[] = []
    const dialogs = {
      confirm: async (o: { title: string; body: string; confirmLabel: string; danger: boolean }) => {
        seen.push(o)
        return false
      },
    } as never
    expect(await confirmQuit(dialogs, 3)).toBe(false)
    expect(seen[0]?.title).toBe('退出 Poietica？')
    expect(seen[0]?.body).toContain('3')
    expect(seen[0]?.body).toContain('退出将中断')
    expect(seen[0]?.confirmLabel).toBe('退出')
    expect(seen[0]?.danger).toBe(true)
  })
})
