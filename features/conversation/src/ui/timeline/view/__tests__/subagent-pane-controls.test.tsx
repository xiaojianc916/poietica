import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { AuxiliaryComposerBar } from '../../../composer'
import { ConfirmStopButton } from '../delegate-channel-view'

/* 子代理标签页的两样控件：停止要点两下才生效；引导框是辅助对话那颗输入药丸。 */

afterEach(cleanup)

describe('ConfirmStopButton', () => {
  test('第一下只换成「确认停止」，第二下才真的停', () => {
    const onConfirm = mock(() => undefined)
    const { getByRole } = render(<ConfirmStopButton disabled={false} onConfirm={onConfirm} />)

    fireEvent.click(getByRole('button'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(getByRole('button').textContent).toBe('确认停止')
    expect(getByRole('button').hasAttribute('data-armed')).toBe(true)

    fireEvent.click(getByRole('button'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(getByRole('button').textContent).toBe('停止')
  })

  test('没点第二下：超时或失焦都退回原样', async () => {
    const onConfirm = mock(() => undefined)
    const { getByRole } = render(<ConfirmStopButton confirmMs={20} disabled={false} onConfirm={onConfirm} />)

    fireEvent.click(getByRole('button'))
    await act(async () => {
      await Bun.sleep(40)
    })
    expect(getByRole('button').textContent).toBe('停止')

    fireEvent.click(getByRole('button'))
    fireEvent.blur(getByRole('button'))
    expect(getByRole('button').textContent).toBe('停止')
    fireEvent.click(getByRole('button'))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('AuxiliaryComposerBar', () => {
  test('回车提交；发送键不可用时不提交', () => {
    const onSubmit = mock(() => undefined)
    const view = render(
      <AuxiliaryComposerBar onChange={() => undefined} onSubmit={onSubmit} placeholder="引导" value="换个思路" />,
    )
    const form = view.container.querySelector('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)
    expect(onSubmit).toHaveBeenCalledTimes(1)

    view.rerender(
      <AuxiliaryComposerBar
        onChange={() => undefined}
        onSubmit={onSubmit}
        placeholder="引导"
        submitDisabled
        value=""
      />,
    )
    fireEvent.submit(view.container.querySelector('form') as HTMLFormElement)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
