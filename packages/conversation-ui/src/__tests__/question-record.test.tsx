import { describe, expect, it } from 'bun:test'
import type { QuestionTimelineItem } from '@poietica/conversation'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuestionRecord } from '../timeline/question-record'

/*
 * 落定的题在转录里的样子。
 *
 * 提问是协议自己的条目（kap 的 questions），不再有「这道帧算不算一道题」的判据
 * 要守 —— 那层闸门整个消失了。剩下两件事要钉住：
 *
 *   还没结清的不上屏   判据在 agent 侧的 renderable.ts，这里守组件自己的防线
 *   结清之后的形态     答过只留被选中的那一个，跳过的说跳过，没答成的写明由来
 *
 * 用 react-dom/server 而不是 testing-library：要守的都只关乎一次渲染的产物，
 * 不需要 DOM，也就不需要为此往这个包里添三个依赖和一套环境配置。
 */

/** 一道题，题面与选项都是协议自己带的。 */
function group(overrides: Partial<QuestionTimelineItem> = {}): QuestionTimelineItem {
  return {
    type: 'question',
    id: 'r0-question-1',
    at: 0,
    turn: 0,
    questionId: 'q-1',
    questions: [
      {
        id: 'q0',
        question: '这一版用哪种配色？',
        options: [
          { id: 'opt-dark', label: '深色' },
          { id: 'opt-light', label: '浅色' },
        ],
        multiSelect: false,
        allowOther: false,
      },
    ],
    ...overrides,
  }
}

describe('落定的题', () => {
  it('还没结清的一行都不画', () => {
    /* renderable 先把这一条挡在转录外；这里守住组件自己的防线。 */
    expect(renderToStaticMarkup(<QuestionRecord item={group()} />)).toBe('')
  })

  it('题面是题自己带来的那句,不是工具名', () => {
    const markup = renderToStaticMarkup(
      <QuestionRecord
        item={group({
          resolution: {
            outcome: 'answered',
            answers: { q0: { kind: 'single', optionId: 'opt-light' } },
            note: '',
          },
        })}
      />,
    )

    expect(markup).toContain('这一版用哪种配色？')
    expect(markup).not.toContain('AskUserQuestion')
  })

  it('答过之后只留被选中的那一个,落选项不再露面', () => {
    const markup = renderToStaticMarkup(
      <QuestionRecord
        item={group({
          resolution: {
            outcome: 'answered',
            answers: { q0: { kind: 'single', optionId: 'opt-light' } },
            note: '',
          },
        })}
      />,
    )

    expect(markup).toContain('assistant-outcome__answer')
    expect(markup).toContain('浅色')
    expect(markup).not.toContain('深色')
  })

  it('跳过也算答复,但不涂成答过', () => {
    const markup = renderToStaticMarkup(
      <QuestionRecord
        item={group({
          resolution: { outcome: 'answered', answers: { q0: { kind: 'skipped' } }, note: '' },
        })}
      />,
    )

    expect(markup).toContain('assistant-outcome__answer')
    expect(markup).toContain('跳过')
    expect(markup).not.toContain('data-answered="true"')
  })

  it('没答成的,由来写成附注,不装成答案', () => {
    const dismissed = renderToStaticMarkup(
      <QuestionRecord
        item={group({ resolution: { outcome: 'dismissed', answers: {}, note: '' } })}
      />,
    )
    const cancelled = renderToStaticMarkup(
      <QuestionRecord
        item={group({ resolution: { outcome: 'cancelled', answers: {}, note: '' } })}
      />,
    )
    const undelivered = renderToStaticMarkup(
      <QuestionRecord
        item={group({ resolution: { outcome: 'undelivered', answers: {}, note: '' } })}
      />,
    )

    expect(dismissed).toContain('这组题被撤下了。')
    expect(cancelled).toContain('这一轮被取消，这组题没有等到答复。')
    expect(undelivered).toContain('答复没能送到 agent 手里。')
    expect(dismissed).not.toContain('data-answered="true"')
  })

  it('整组的备注只挂在最后一张卡上', () => {
    const markup = renderToStaticMarkup(
      <QuestionRecord
        item={group({
          questions: [
            { id: 'q0', question: '第一题？', options: [], multiSelect: false, allowOther: false },
            { id: 'q1', question: '第二题？', options: [], multiSelect: false, allowOther: false },
          ],
          resolution: {
            outcome: 'answered',
            answers: {
              q0: { kind: 'single', optionId: 'a' },
              q1: { kind: 'single', optionId: 'b' },
            },
            note: '就按这个来。',
          },
        })}
      />,
    )

    expect(markup.match(/就按这个来。/g)).toHaveLength(1)
  })
})
