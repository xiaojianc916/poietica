import type { QuestionTimelineItem } from '@poietica/agent'
import { describeAnswer } from '../composer/question-answer'
import { OutcomeCard } from './outcome-card'

/*
 * 一组落定的题：逐题一张卡。
 *
 * 还没结清的不上屏（renderable 是同一处判据）—— 它正长在输入框那张卡里。没答成
 * 的由来写成附注，不装成答案；整组的备注挂在最后一张卡上。
 */

const UNANSWERED = {
  dismissed: '这组题被撤下了。',
  cancelled: '这一轮被取消，这组题没有等到答复。',
  undelivered: '答复没能送到 agent 手里。',
} as const

export function QuestionRecord({ item }: { readonly item: QuestionTimelineItem }) {
  const resolution = item.resolution

  if (resolution === undefined) {
    return null
  }

  const last = item.questions.length - 1

  return (
    <>
      {item.questions.map((question, index) => {
        const answer = resolution.answers[question.id]
        const notes: string[] = []

        if (resolution.outcome !== 'answered') {
          notes.push(UNANSWERED[resolution.outcome])
        }

        if (index === last && resolution.note.length > 0) {
          notes.push(resolution.note)
        }

        const note = notes.join(' ')

        return (
          <OutcomeCard
            answer={answer === undefined ? undefined : describeAnswer(question, answer)}
            answered={
              resolution.outcome === 'answered' && answer !== undefined && answer.kind !== 'skipped'
            }
            key={question.id}
            note={note.length === 0 ? undefined : note}
            prompt={question.question}
          />
        )
      })}
    </>
  )
}
