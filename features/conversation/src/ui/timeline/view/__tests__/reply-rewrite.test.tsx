import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ReplyActions } from '../reply-actions'

/* O-03：重写与分叉同一个轮号、同一条可用性；重写交出的是这一轮的轮号（由组合根换成 keepTurns = 轮号 − 1）。 */

afterEach(cleanup)

describe('回复下的重写钮', () => {
  test('收口的轮：点下去交出这一轮的轮号', () => {
    const rewrites: number[] = []
    const view = render(
      <ReplyActions
        forkUnavailableReason={null}
        keepTurns={3}
        onFork={() => undefined}
        onRewrite={(turn) => rewrites.push(turn)}
        text="答"
      />,
    )
    fireEvent.click(view.getByRole('button', { name: '从这一轮重写' }))
    expect(rewrites).toEqual([3])
  })

  test('还在跑的轮：与分叉一起灰掉，原因写进名字', () => {
    const view = render(
      <ReplyActions
        forkUnavailableReason="会话仍在运行或等待输入，暂不可分叉。"
        keepTurns={null}
        onFork={() => undefined}
        onRewrite={() => undefined}
        text="答"
      />,
    )
    const button = view.getByRole('button', { name: /^从这一轮重写（/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  test('组合根不给 onRewrite 就不画', () => {
    const view = render(<ReplyActions forkUnavailableReason={null} keepTurns={1} onFork={undefined} text="答" />)
    expect(view.queryByRole('button', { name: /从这一轮重写/ })).toBeNull()
  })
})
