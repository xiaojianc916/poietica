import { describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionGoal } from '../../agent/goal'
import { GoalBar, useGoalActions } from '../goal/goal-bar'
import type { GoalAction, GoalActionHandler, GoalActionResult } from '../goal/goal-control'

/*
 * 目标栏的动作（审查 R-10）。
 *
 * 旧目标栏把动作交给 onSelect 之后立刻当成功：暂停 / 继续 / 改正文在上一层被整条丢掉，
 * 人点了既没有变化也没有报错。这里钉三件事：每个按钮交出去的是**哪一个动作**；
 * 等到出口真的答复才算完（期间按钮 disabled）；失败的那句话亮在 role=alert 上。
 */

function goalOf(over: Partial<SessionGoal> = {}): SessionGoal {
  return {
    objective: '把测试迁完',
    completionCriterion: null,
    status: 'active',
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    receivedAt: 0,
    ...over,
  }
}

/** 与 AssistantSurface 同一种接法：钩子挂在外面，目标栏只拿结果。 */
function Harness({ goal, onAction }: { readonly goal: SessionGoal; readonly onAction: GoalActionHandler }) {
  const actions = useGoalActions(onAction, goal.objective)
  return <GoalBar actions={actions} goal={goal} />
}

interface Recorder {
  readonly calls: GoalAction[]
  readonly onAction: GoalActionHandler
  /** 让最早那一个还没答复的动作以 result 答复 */
  settle(result: GoalActionResult): void
}

/** 出口替身：记下每个动作，答复由测试手动给（在途窗口才测得到）。 */
function recorder(): Recorder {
  const calls: GoalAction[] = []
  const waiting: ((result: GoalActionResult) => void)[] = []
  return {
    calls,
    onAction: (action) => {
      calls.push(action)
      return new Promise<GoalActionResult>((resolve) => {
        waiting.push(resolve)
      })
    },
    settle: (result) => {
      waiting.shift()?.(result)
    },
  }
}

const OK: GoalActionResult = { ok: true }
const button = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe('目标栏动作（审查 R-10）', () => {
  test('GB1 点「暂停目标」：出口收到 pause；答复之前按钮全部 disabled，答复之后恢复', async () => {
    const r = recorder()
    const { container } = render(<Harness goal={goalOf()} onAction={r.onAction} />)

    await act(async () => {
      fireEvent.click(button(container, '暂停目标')!)
    })
    expect(r.calls).toEqual([{ kind: 'pause' }])
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every((b) => b.disabled)).toBe(true)

    await act(async () => {
      r.settle(OK)
    })
    expect([...container.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    cleanup()
  })

  test('GB2 已暂停的目标：按钮是「恢复目标」，点了出口收到 resume', async () => {
    const r = recorder()
    const { container } = render(<Harness goal={goalOf({ status: 'paused' })} onAction={r.onAction} />)

    expect(container.textContent).toContain('已暂停的目标')
    expect(button(container, '暂停目标')).toBeNull()
    await act(async () => {
      fireEvent.click(button(container, '恢复目标')!)
    })
    expect(r.calls).toEqual([{ kind: 'resume' }])
    cleanup()
  })

  test('GB3 失败：那句话亮在 role=alert 上；目标换了之后不再显示', async () => {
    const r = recorder()
    const { container, rerender } = render(<Harness goal={goalOf()} onAction={r.onAction} />)

    await act(async () => {
      fireEvent.click(button(container, '清除目标')!)
    })
    await act(async () => {
      r.settle({ ok: false, error: '这条对话没有进行中的目标' })
    })
    expect(r.calls).toEqual([{ kind: 'clear' }])
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('这条对话没有进行中的目标')

    rerender(<Harness goal={goalOf({ objective: '另一个目标' })} onAction={r.onAction} />)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    cleanup()
  })

  test('GB4 改正文：回车交出 edit（去掉首尾空格）；成功之后收起输入框', async () => {
    const r = recorder()
    const { container } = render(<Harness goal={goalOf()} onAction={r.onAction} />)

    await act(async () => {
      fireEvent.click(button(container, '编辑目标')!)
    })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="目标内容"]')!
    await act(async () => {
      fireEvent.change(input, { target: { value: '  把测试迁完并补文档  ' } })
    })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(r.calls).toEqual([{ kind: 'edit', objective: '把测试迁完并补文档' }])
    // 答复之前仍在编辑（失败了人还能改）
    expect(container.querySelector('input[aria-label="目标内容"]')).not.toBeNull()

    await act(async () => {
      r.settle(OK)
    })
    expect(container.querySelector('input[aria-label="目标内容"]')).toBeNull()
    cleanup()
  })

  test('GB5 改正文：正文没变就回车 → 不下发，直接收起', async () => {
    const r = recorder()
    const { container } = render(<Harness goal={goalOf()} onAction={r.onAction} />)

    await act(async () => {
      fireEvent.click(button(container, '编辑目标')!)
    })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="目标内容"]')!
    await act(async () => {
      fireEvent.change(input, { target: { value: ' 把测试迁完 ' } })
    })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(r.calls).toEqual([])
    expect(container.querySelector('input[aria-label="目标内容"]')).toBeNull()
    cleanup()
  })

  test('GB6 在途时再发一个：不下发（一次只走一个）', async () => {
    const r = recorder()
    function RunTwice() {
      const actions = useGoalActions(r.onAction, '把测试迁完')
      return (
        <button
          onClick={() => {
            void actions.run({ kind: 'pause' })
            void actions.run({ kind: 'resume' })
          }}
          type="button"
        >
          go
        </button>
      )
    }
    const { container } = render(<RunTwice />)

    await act(async () => {
      fireEvent.click(container.querySelector('button')!)
    })
    expect(r.calls).toEqual([{ kind: 'pause' }])
    cleanup()
  })

  test('GB7 出口违约 reject：按钮不卡在 pending，错误照样亮出来', async () => {
    const { container } = render(<Harness goal={goalOf()} onAction={() => Promise.reject(new Error('boom'))} />)

    await act(async () => {
      fireEvent.click(button(container, '暂停目标')!)
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Error: boom')
    expect(button(container, '暂停目标')!.disabled).toBe(false)
    cleanup()
  })
})
