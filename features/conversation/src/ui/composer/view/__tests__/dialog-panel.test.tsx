import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { DialogAnswer, DialogRequest } from '../../../shared/model/dialog'
import type { QuestionTimelineItem } from '../../../shared/timeline/timeline-contract'
import { DialogPanel } from '../dialog-panel'

/*
 * 单问面板（Q1-E）：确认 / 单选 / 输入从前按审批画、答成 approval，broker 按种类对不上就拒收。
 * 这里钉的是**交出去的那一份**：种类是单问自己的，值是布尔 / 选项原文 / 那句话。
 */

afterEach(cleanup)

const itemOf = (dialog: DialogRequest): QuestionTimelineItem => ({
  type: 'question',
  id: 'i1',
  turn: 1,
  at: 0,
  questionId: 'i1',
  questions: [],
  dialog,
})

function mount(dialog: DialogRequest) {
  const answers: { id: string; answer: DialogAnswer }[] = []
  const dismissed: string[] = []
  const view = render(
    <DialogPanel
      item={itemOf(dialog)}
      onAnswer={async (id, answer) => {
        answers.push({ id, answer })
      }}
      onDismiss={async (id) => {
        dismissed.push(id)
      }}
    />,
  )
  return { view, answers, dismissed }
}

const settle = () => act(async () => await Promise.resolve())

describe('DialogPanel', () => {
  test('确认：两个键各交一个布尔，正文画在题面下', async () => {
    const yes = mount({ kind: 'confirm', title: '继续吗？', message: '将覆盖 3 个文件' })
    expect(yes.view.getByText('将覆盖 3 个文件')).toBeTruthy()
    fireEvent.click(yes.view.getByRole('button', { name: '确认' }))
    await settle()
    expect(yes.answers).toEqual([{ id: 'i1', answer: { kind: 'confirm', value: true } }])
    cleanup()

    const no = mount({ kind: 'confirm', title: '继续吗？', message: '' })
    fireEvent.click(no.view.getByRole('button', { name: '不确认' }))
    await settle()
    expect(no.answers).toEqual([{ id: 'i1', answer: { kind: 'confirm', value: false } }])
  })

  test('单选：没选交不出；交出的是那条原文，原文重复也按位置认', async () => {
    const { view, answers } = mount({ kind: 'select', title: '用哪个？', options: ['甲', '乙', '乙'] })
    const submit = view.getByRole('button', { name: '提交' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(view.getAllByRole('button', { name: /乙/ })[1]!)
    expect(view.getAllByRole('button', { pressed: true })).toHaveLength(1)
    fireEvent.click(submit)
    await settle()
    expect(answers).toEqual([{ id: 'i1', answer: { kind: 'select', value: '乙' } }])
  })

  test('输入：单行回车就交，多行以预填为起点', async () => {
    const line = mount({ kind: 'input', title: '起个名', placeholder: '比如 poietica', multiline: false })
    const field = line.view.getByPlaceholderText('比如 poietica')
    fireEvent.change(field, { target: { value: '小诗' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await settle()
    expect(line.answers).toEqual([{ id: 'i1', answer: { kind: 'input', value: '小诗' } }])
    cleanup()

    const many = mount({ kind: 'input', title: '正文', placeholder: '预填', multiline: true })
    const area = many.view.getByLabelText('正文') as HTMLTextAreaElement
    expect(area.tagName).toBe('TEXTAREA')
    expect(area.value).toBe('预填')
    fireEvent.change(area, { target: { value: '预填\n第二行' } })
    fireEvent.click(many.view.getByRole('button', { name: '提交' }))
    await settle()
    expect(many.answers).toEqual([{ id: 'i1', answer: { kind: 'input', value: '预填\n第二行' } }])
  })

  test('撤下走题组那条 dismiss，不交答复', async () => {
    const { view, answers, dismissed } = mount({ kind: 'select', title: '用哪个？', options: ['甲'] })
    fireEvent.click(view.getByRole('button', { name: '撤下这一问' }))
    await settle()
    expect(dismissed).toEqual(['i1'])
    expect(answers).toEqual([])
  })
})
