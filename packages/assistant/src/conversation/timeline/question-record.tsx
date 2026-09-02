import './question-record.css'

import type { QuestionTimelineItem } from '@poietica/conversation'
import { describeAnswer } from '../composer/question-answer'
import { Prose } from './prose'

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
    <ol aria-label="提问结果" className="assistant-question-record" data-surface="">
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
        const answered =
          resolution.outcome === 'answered' && answer !== undefined && answer.kind !== 'skipped'

        return (
          <li
            className="assistant-question-record__item"
            data-answered={answered ? 'true' : undefined}
            key={question.id}
          >
            <Prose className="assistant-question-record__prompt" text={question.question} />

            {answer === undefined ? null : (
              <p className="assistant-question-record__answer">
                {describeAnswer(question, answer)}
              </p>
            )}

            {note.length === 0 ? null : <p className="assistant-question-record__note">{note}</p>}
          </li>
        )
      })}
    </ol>
  )
}
