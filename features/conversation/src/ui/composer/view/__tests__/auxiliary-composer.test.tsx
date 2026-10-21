import { afterEach, describe, expect, test } from 'bun:test'
import type { SideTopic, SideTurn } from '@poietica/engine'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createSideStore, type SideApi } from '../../side-store'
import { AuxiliaryComposer, sideTopicGroups, sideTopicMeta } from '../auxiliary-composer'

/*
 * 右坞「辅助对话」：空状态说清它是什么、列最近的话题；问一句 → 选中那个话题看答案；正在答时发送键是停止键（Esc 同）；
 * 答完的能复制、放进主输入框；没答成的最后一问能重问。数据来自 side store（这里的 api 是替身）。
 */
afterEach(cleanup)

const turn = (patch: Partial<SideTurn> = {}): SideTurn => ({
  question: '这个函数在干嘛？',
  answer: '',
  status: 'complete',
  createdAt: 1,
  updatedAt: 1,
  error: null,
  ...patch,
})

function setup(listed: readonly SideTopic[] = [], overrides: Partial<SideApi> = {}) {
  const asked: Array<{ question: string; topicId: string | null }> = []
  const cancelled: Array<string | null> = []
  const inserted: string[] = []
  const api: SideApi = {
    listSide: async () => listed,
    askSide: async (_threadId, question, topicId) => {
      asked.push({ question, topicId })
      return { id: topicId ?? 'fresh', leafId: null, turns: [turn({ question, status: 'running', createdAt: 9 })] }
    },
    cancelSide: async (_threadId, topicId) => {
      cancelled.push(topicId)
      return true
    },
    ...overrides,
  }
  const side = createSideStore(api)
  const view = render(
    <AuxiliaryComposer
      controls={[]}
      onInsert={(_threadId, text) => inserted.push(text)}
      onSelectControl={() => undefined}
      side={side}
      threadId="t1"
    />,
  )
  return { ...view, side, asked, cancelled, inserted }
}

describe('辅助对话', () => {
  test('没有对话：只说一句去哪儿用它，不画输入条', () => {
    const { container, getByText } = render(
      <AuxiliaryComposer
        controls={[]}
        onInsert={() => undefined}
        onSelectControl={() => undefined}
        side={createSideStore({
          listSide: async () => [],
          askSide: async () => ({}) as never,
          cancelSide: async () => false,
        })}
        threadId={null}
      />,
    )
    expect(getByText('打开一条对话后，可以在这里就它随口问一句。')).toBeTruthy()
    expect(container.querySelector('form')).toBeNull()
  })

  test('空状态：说明不调用工具、不进对话记录，并列出最近的话题；点进去看问答', async () => {
    const { findByText, getByText, container } = setup([
      { id: 'a', leafId: null, turns: [turn({ answer: '它把参数拼成一条命令。' })] },
    ])
    fireEvent.click(await findByText('这个函数在干嘛？'))
    expect(container.querySelector('.auxiliary-chat__question')?.textContent).toBe('这个函数在干嘛？')
    expect(container.querySelector('.auxiliary-chat__answer')?.textContent).toContain('它把参数拼成一条命令。')
    fireEvent.click(getByText('全部话题'))
    expect(container.querySelector('.auxiliary-chat__intro')).not.toBeNull()
  })

  test('问一句：发出去、选中新话题；正在答时发送键换成停止键，点它或按 Esc 都停', async () => {
    const { asked, cancelled, container, getByLabelText, findByText } = setup()
    const field = getByLabelText('侧边提问') as HTMLInputElement
    fireEvent.change(field, { target: { value: '  顺便问一句  ' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    await findByText('正在想…')
    expect(asked).toEqual([{ question: '顺便问一句', topicId: null }])
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('接着问...')

    fireEvent.click(getByLabelText('停止回答'))
    await waitFor(() => expect(cancelled).toEqual(['fresh']))
    fireEvent.keyDown(field, { key: 'Escape' })
    await waitFor(() => expect(cancelled).toEqual(['fresh', 'fresh']))
    expect(container.querySelector('[data-running="true"]')).not.toBeNull()
  })

  test('答完的能复制、放进输入框；被停掉的最后一问能重问（同一个话题里再问一遍）', async () => {
    const { asked, findByText, getByLabelText, getByText, inserted, side } = setup([
      {
        id: 'a',
        leafId: null,
        turns: [turn({ answer: '第一段答案' }), turn({ question: '再细一点', answer: '', status: 'cancelled' })],
      },
    ])
    fireEvent.click(await findByText('这个函数在干嘛？'))
    expect(getByText('已停止')).toBeTruthy()
    fireEvent.click(getByLabelText('放进输入框'))
    expect(inserted).toEqual(['第一段答案'])
    fireEvent.click(getByText('重问一次'))
    await waitFor(() => expect(asked).toEqual([{ question: '再细一点', topicId: 'a' }]))
    expect(side.of('t1').selected).toBe('a')
  })

  test('发问失败：问题放回输入框，提示可以关掉', async () => {
    const { findByRole, getByLabelText, queryByRole } = setup([], {
      askSide: async () => {
        throw new Error('上一个侧边提问还没答完')
      },
    })
    const field = getByLabelText('侧边提问') as HTMLInputElement
    fireEvent.change(field, { target: { value: '问' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    expect((await findByRole('alert')).textContent).toContain('上一个侧边提问还没答完')
    expect(field.value).toBe('问')
    act(() => {
      fireEvent.click(getByLabelText('关闭提示'))
    })
    expect(queryByRole('alert')).toBeNull()
  })

  test('加号面板：新话题在第一行，选中的话题打勾；话题说明带状态与问数', () => {
    const topics: SideTopic[] = [
      { id: 'a', leafId: null, turns: [turn(), turn({ status: 'error', error: 'boom' })] },
      { id: 'b', leafId: null, turns: [turn()] },
    ]
    const [group] = sideTopicGroups({ topics, selected: 'a' }, () => undefined)
    expect(group?.rows.map((row) => [row.label, row.checked])).toEqual([
      ['新话题', false],
      ['这个函数在干嘛？', true],
      ['这个函数在干嘛？', false],
    ])
    expect(sideTopicMeta(topics[0] as SideTopic)).toBe('出错了 · 2 问')
    expect(sideTopicMeta(topics[1] as SideTopic)).toBeUndefined()
  })
})
