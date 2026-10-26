import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionConfigControl } from '../../../shared/model/config'
import { SessionControls } from '../session-controls'

/* U-04：斜杠命令 `/model` 等于点开模型选择器 —— 请求号一变就打开，直接落在模型清单那一页；`/effort` 落在档位页。 */
afterEach(cleanup)

const MODEL_REQUEST = { seq: 1, pane: 'model' } as const

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
      view.rerender(<SessionControls controls={controls} onSelect={() => undefined} openRequest={MODEL_REQUEST} />)
    })
    expect(screen.getByText('Claude Opus')).toBeDefined()
  })

  test('表还没确认（pending）时先不开，等表到了再开：/model 不会因为模型列表在转圈就落空', async () => {
    const view = render(<SessionControls controls={controls} onSelect={() => undefined} pending />)
    await act(async () => {
      view.rerender(
        <SessionControls controls={controls} onSelect={() => undefined} openRequest={MODEL_REQUEST} pending />,
      )
    })
    expect(screen.queryByText('Claude Opus')).toBeNull()

    await act(async () => {
      view.rerender(<SessionControls controls={controls} onSelect={() => undefined} openRequest={MODEL_REQUEST} />)
    })
    expect(screen.getByText('Claude Opus')).toBeDefined()
  })

  test('/effort 落在档位页，不进模型清单', async () => {
    const view = render(<SessionControls controls={controls} onSelect={() => undefined} />)
    await act(async () => {
      view.rerender(
        <SessionControls controls={controls} onSelect={() => undefined} openRequest={{ seq: 1, pane: 'level' }} />,
      )
    })
    expect(document.querySelector('.assistant-model-select__band-pane')).not.toBeNull()
    expect(screen.queryByText('Claude Opus')).toBeNull()
  })
})

/*
 * 退场那 120ms 里弹层还在画：关的那一下若把页换回档位页，卡片会先闪一下档位页再消失。
 * happy-dom 里退场同样要等一拍才卸载，所以「刚点完、卡还在」这一刻量得到。
 */
describe('模型选择器的开合与换页', () => {
  const popup = () => document.querySelector('.assistant-model-select__panel')
  const showing = (pane: 'band' | 'list') => document.querySelector(`.assistant-model-select__${pane}-pane`) !== null

  test('在清单页点选模型：退场时卡里仍是清单页，不闪回档位页', async () => {
    const view = render(<SessionControls controls={controls} onSelect={() => undefined} />)
    await act(async () => {
      view.rerender(<SessionControls controls={controls} onSelect={() => undefined} openRequest={MODEL_REQUEST} />)
    })
    expect(showing('list')).toBe(true)

    act(() => {
      fireEvent.click(screen.getByText('Claude Opus'))
    })

    expect(popup()).not.toBeNull()
    expect(showing('band')).toBe(false)
    expect(showing('list')).toBe(true)
  })

  test('清单页的 Escape 退回档位页，卡不关；档位页的 Escape 才关', async () => {
    const view = render(<SessionControls controls={controls} onSelect={() => undefined} />)
    await act(async () => {
      view.rerender(<SessionControls controls={controls} onSelect={() => undefined} openRequest={MODEL_REQUEST} />)
    })
    expect(showing('list')).toBe(true)

    await act(async () => {
      fireEvent.keyDown(popup() as Element, { key: 'Escape' })
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(popup()).not.toBeNull()
    expect(showing('band')).toBe(true)
    /* 焦点回到进清单的那一行（那一行写着模型名），而不是被菜单接到卡里第一个可 Tab 的档位滑块上 */
    expect(document.activeElement?.textContent ?? '').toContain('DeepSeek V4')

    await act(async () => {
      fireEvent.keyDown(popup() as Element, { key: 'Escape' })
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(popup()).toBeNull()
  })

  test('关的时候不换页，但下一次从胶囊打开仍从档位页进', async () => {
    const view = render(<SessionControls controls={controls} onSelect={() => undefined} />)
    await act(async () => {
      view.rerender(<SessionControls controls={controls} onSelect={() => undefined} openRequest={MODEL_REQUEST} />)
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Claude Opus'))
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(popup()).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '模型与思考档位' }))
    })
    expect(showing('band')).toBe(true)
    expect(showing('list')).toBe(false)
  })
})
