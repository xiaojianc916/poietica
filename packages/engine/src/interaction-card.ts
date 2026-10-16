import type {
  InteractionState,
  QuestionAnswerValue,
  QuestionRequest,
  TranscriptInteraction,
} from '@poietica/transcript'
import type { Interaction, InteractionAnswer } from './values'

/*
 * 引擎交互 → 时间线卡片（Q1-C）。映射只此一处：真引擎与替身都从这里出卡片，界面按 transcript 的类型读，
 * 不再认引擎的字段名。select / input / confirm 各有自己的卡片（Q1-E）：从前按审批画，界面只会答 `approval`，
 * broker 按种类对不上就拒收，时间线上一张也答不了。
 */

/** 答复 → 卡片终态：没有答复（超时、中止、撤下）是 cancelled；确认类按 true/false 分。 */
export function interactionStateOf(answer: InteractionAnswer | undefined): Exclude<InteractionState, 'pending'> {
  if (answer === undefined || answer.kind === 'dismiss') return 'cancelled'
  if (answer.kind === 'approval') return answer.decision === 'approve' ? 'approved' : 'rejected'
  /* 计划三档与卡片终态逐档对应：批准 / 要求修改 / 否决 */
  if (answer.kind === 'plan') {
    if (answer.decision === 'approve') return 'approved'
    return answer.decision === 'revise' ? 'answered' : 'rejected'
  }
  if (answer.kind === 'confirm') return answer.value ? 'approved' : 'rejected'
  return 'answered'
}

/**
 * 一次交互的卡片。`resolution` 缺席就是待答；在场时按答复定终态。请求两种状态都带上 ——
 * 收口那一次 upsert 会整条替换，只带答复的话题面与计划正文就丢了。
 */
export function interactionCardOf(
  interaction: Interaction,
  resolution?: { readonly answer: InteractionAnswer | undefined },
): TranscriptInteraction {
  const base = {
    interactionId: interaction.id,
    state: resolution === undefined ? ('pending' as const) : interactionStateOf(resolution.answer),
  }
  const answer = resolution?.answer
  switch (interaction.kind) {
    case 'plan':
      return {
        ...base,
        interactionKind: 'plan',
        request: {
          title: interaction.title,
          planFilePath: interaction.planFilePath,
          planMarkdown: interaction.planMarkdown,
        },
        ...(answer?.kind === 'plan' ? { response: { decision: answer.decision, ...feedbackOf(answer.feedback) } } : {}),
      }
    case 'question':
      return {
        ...base,
        interactionKind: 'question',
        request: questionRequestOf(interaction),
        ...(answer?.kind === 'question' ? { response: { answers: answersOf(answer.answers) } } : {}),
      }
    case 'confirm':
    case 'select':
    case 'input':
      return dialogCardOf(interaction, base, answer)
    case 'approval':
      return {
        ...base,
        interactionKind: 'approval',
        request: {
          toolName: interaction.tool,
          title: interaction.title,
          detail: interaction.detail,
          allowSessionScope: interaction.allowSessionScope,
        },
        ...(answer?.kind === 'approval'
          ? { response: { decision: answer.decision, scope: answer.scope, ...feedbackOf(answer.feedback) } }
          : {}),
      }
  }
}

/** 三类单问各自的卡片（Q1-E）：请求照抄，答复只认同种类的那一支。 */
function dialogCardOf(
  interaction: Extract<Interaction, { kind: 'confirm' | 'select' | 'input' }>,
  base: Pick<TranscriptInteraction, 'interactionId' | 'state'>,
  answer: InteractionAnswer | undefined,
): TranscriptInteraction {
  switch (interaction.kind) {
    case 'confirm':
      return {
        ...base,
        interactionKind: 'confirm',
        request: { title: interaction.title, message: interaction.message },
        ...(answer?.kind === 'confirm' ? { response: { value: answer.value } } : {}),
      }
    case 'select':
      return {
        ...base,
        interactionKind: 'select',
        request: { title: interaction.title, options: [...interaction.options] },
        ...(answer?.kind === 'select' ? { response: chosenOf(answer.value) } : {}),
      }
    case 'input':
      return {
        ...base,
        interactionKind: 'input',
        request: {
          title: interaction.title,
          ...(interaction.placeholder === null ? {} : { placeholder: interaction.placeholder }),
          multiline: interaction.multiline,
        },
        ...(answer?.kind === 'input' ? { response: chosenOf(answer.value) } : {}),
      }
  }
}

function questionRequestOf(interaction: Extract<Interaction, { kind: 'question' }>): QuestionRequest {
  return {
    questions: interaction.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      multiple: question.multiple,
      allowCustom: question.allowCustom,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === null ? {} : { description: option.description }),
      })),
    })),
  }
}

function answersOf(
  answers: Extract<InteractionAnswer, { kind: 'question' }>['answers'],
): Record<string, QuestionAnswerValue> {
  const out: Record<string, QuestionAnswerValue> = {}
  for (const [id, answer] of Object.entries(answers)) {
    out[id] = { selected: [...answer.selected], ...(answer.custom === null ? {} : { custom: answer.custom }) }
  }
  return out
}

/** select / input 的答复：引擎的「没选 / 没填」是 null，词表是缺席。 */
function chosenOf(value: string | null): { readonly value?: string } {
  return value === null ? {} : { value }
}

/** 引擎的「没有」是 null，词表的「没有」是缺席。 */
function feedbackOf(feedback: string | null): { readonly feedback?: string } {
  return feedback === null ? {} : { feedback }
}
