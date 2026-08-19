import type { QuestionTimelineItem } from '@poietica/agent'
import { describeAnswer } from '../composer/question-answer'
import { OutcomeCard } from './outcome-card'

/*
 * 一组题落定之后的留影：逐题一张卡。
 *
 * 题面、答复、附注三个槽都是 OutcomeCard 的，这里只负责把协议的 answers 读成
 * 人看的一句。没答成的由来（撤下、随轮取消、没送达）写成附注，不装成答案。
 * 整组的备注挂在最后一张卡上 —— 它是给这组题的，不是给其中某一道的。
 */

/* outcome 的三种「没答成」，各自的说明。 */
const UNANSWERED = {
  dismissed: '这组题被撤下了。',
  cancelled: '这一轮被取消，这组题没有等到答复。',
  undelivered: '答复没能送到 agent 手里。',
} as const

export function QuestionOutcome({ item }: { readonly item: QuestionTimelineItem }) {
  const resolution = item.resolution

  /* 还在等的题不上屏：它正长在输入框那张卡里（renderable 是同一处判据）。 */
  if (resolution === undefined) {
    return null
  }

  const last = item.questions.length - 1

  return (
    <>
      {item.questions.map((question, index) => {
        const answer = resolution.answers[question.id]
        const reason =
          resolution.outcome === 'answered' ? undefined : UNANSWERED[resolution.outcome]
        const note =
          index === last && resolution.note.length > 0
            ? reason === undefined
              ? resolution.note
              : reason + ' ' + resolution.note
            : reason

        return (
          <OutcomeCard
            answer={answer === undefined ? undefined : describeAnswer(question, answer)}
            answered={
              resolution.outcome === 'answered' && answer !== undefined && answer.kind !== 'skipped'
            }
            key={question.id}
            note={note}
            prompt={question.question}
          />
        )
      })}
    </>
  )
}
