import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { SessionConfigControl } from '../../../shared/model/config'
import { SessionControls } from '../session-controls'

/* U-04：斜杠命令 `/model` 等于点开模型选择器 —— 请求号一变就打开，直接落在模型清单那一页。 */
afterEach(cleanup)

const controls: readonly SessionConfigControl[] = [
  {
    id: 'model',
    label: '模型',
    purpose: 'model',
    current: 'a',
    choices: [
      { value: 'a', label: 'DeepSeek V4' },
      { value: 'b', label: 'Claude Opus' },
    ],
  },
  {
    id: 'thought',
    label: '思考',
    purpose: 'thought',
    current: 'high',
    choices: [
      { value: 'low', label: 'low' },
      { value: 'high', label: 'high' },
    ],
  },
]

describe('模型选择器的外部打开', () => {
  test('请求号一变就打开，落在模型清单；没变就不开', async () => {
    const view = render(<SessionControls controls={controls} onSelect={() => undefined} />)
    expect(screen.queryByText('Claude Opus')).toBeNull()

    await act(async () => {
      view.rerender(<SessionControls controls={controls} onSelect={() => undefined} openRequest={1} />)
    })
    expect(screen.getByText('Claude Opus')).toBeDefined()
  })

  test('表还没确认（pending）时不开：点不动的东西也不该被命令打开', async () => {
    const view = render(<SessionControls controls={controls} onSelect={() => undefined} pending />)
    await act(async () => {
      view.rerender(<SessionControls controls={controls} onSelect={() => undefined} openRequest={1} pending />)
    })
    expect(screen.queryByText('Claude Opus')).toBeNull()
  })
})
