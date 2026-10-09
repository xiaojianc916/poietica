import { describe, expect, test } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { completionBody, confirmQuit, isTurnSettled, shouldNotify } from '../stores/notify'
import { useThreadSessionLifecycle } from '../thread-lifecycle'

/*
 * 07 页 §5E 的通知表（完成 / 失败 / 需要确认）与退出确认的判据层。
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

describe('useThreadSessionLifecycle（挂载预热 / 卸载释放）', () => {
  test('挂载发 threads.open；卸载发 threads.close', async () => {
    const calls: string[] = []
    const hook = renderHook(
      (props: { threadId: string }) =>
        useThreadSessionLifecycle({
          threadId: props.threadId,
          open: async (id) => {
            calls.push(`open:${id}`)
          },
          close: async (id) => {
            calls.push(`close:${id}`)
          },
        }),
      { initialProps: { threadId: 't1' } },
    )

    await Bun.sleep(10)
    expect(calls).toEqual(['open:t1'])

    hook.unmount()
    await Bun.sleep(10)
    expect(calls).toEqual(['open:t1', 'close:t1'])
  })

  test('StrictMode 的双渲染（卸载后立刻重挂同一线程）不发 close', async () => {
    const calls: string[] = []
    const hook = renderHook(
      () =>
        useThreadSessionLifecycle({
          threadId: 't1',
          open: async (id) => {
            calls.push(`open:${id}`)
          },
          close: async (id) => {
            calls.push(`close:${id}`)
          },
        }),
      { wrapper: StrictMode },
    )
    /*
     * StrictMode 会把 effect 跑两遍（挂载 → 清理 → 挂载）。清理里排的 close 必须被
     * 紧随其后的挂载取消掉，否则每一屏都会白关一次刚预热的会话。
     */
    await Bun.sleep(2)
    expect(calls).toEqual(['open:t1', 'open:t1'])
    hook.unmount()
    await Bun.sleep(10)
    expect(calls).toEqual(['open:t1', 'open:t1', 'close:t1'])
  })
})
