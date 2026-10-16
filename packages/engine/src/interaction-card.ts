import type {
  ApprovalRequest,
  InteractionState,
  QuestionAnswerValue,
  QuestionRequest,
  TranscriptInteraction,
} from '@poietica/transcript'
import type { Interaction, InteractionAnswer } from './values'

/*
 * 引擎交互 → 时间线卡片（Q1-C）。映射只此一处：真引擎与替身都从这里出卡片，界面按 transcript 的类型读，
 * 不再认引擎的字段名。select / input / confirm 没有自己的卡片，按审批画（主语空、正文是那句问话）。
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
    default:
      return {
        ...base,
        interactionKind: 'approval',
        request: approvalRequestOf(interaction),
        ...(answer?.kind === 'approval'
          ? { response: { decision: answer.decision, scope: answer.scope, ...feedbackOf(answer.feedback) } }
          : answer?.kind === 'confirm'
            ? { response: { decision: answer.value ? 'approve' : 'reject', scope: 'once' } }
            : {}),
      }
  }
}

function approvalRequestOf(interaction: Exclude<Interaction, { kind: 'plan' | 'question' }>): ApprovalRequest {
  switch (interaction.kind) {
    case 'approval':
      return {
        toolName: interaction.tool,
        title: interaction.title,
        detail: interaction.detail,
        allowSessionScope: interaction.allowSessionScope,
      }
    case 'confirm':
      return { toolName: '', title: interaction.title, detail: interaction.message, allowSessionScope: false }
    case 'select':
      return {
        toolName: '',
        title: interaction.title,
        detail: interaction.options.join('\n'),
        allowSessionScope: false,
      }
    case 'input':
      return { toolName: '', title: interaction.title, detail: '', allowSessionScope: false }
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

/** 引擎的「没有」是 null，词表的「没有」是缺席。 */
function feedbackOf(feedback: string | null): { readonly feedback?: string } {
  return feedback === null ? {} : { feedback }
}
