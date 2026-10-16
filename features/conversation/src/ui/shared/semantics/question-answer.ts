import type {
  QuestionAnswer,
  QuestionAnswerMethod,
  QuestionChoice,
  QuestionItem,
  QuestionResponse,
} from '../model/question'

/*
 * 面板草稿 → 协议答复，全是纯函数，协议形状的对账只有这一处；反方向（一条答复读回一句话）住在
 * transcript-projector.ts —— 这里反向 import 会造出包内环。
 */

export interface QuestionDraft {
  /** 按勾选先后。 */
  readonly picked: readonly string[]
  readonly written: string
  readonly skipped: boolean
}

export const EMPTY_DRAFT: QuestionDraft = { picked: [], written: '', skipped: false }

/**
 * 还答不出来时是 undefined。跳过压过一切；单选只留最后勾的那一枚 —— 那一枚由面板在写草稿时裁好，这里不猜。
 */
export function answerOf(item: QuestionItem, draft: QuestionDraft): QuestionChoice | undefined {
  if (draft.skipped) {
    return { kind: 'skipped' }
  }

  const written = draft.written.trim()

  if (item.multiSelect === true) {
    if (draft.picked.length > 0 && written.length > 0) {
      return { kind: 'multi_with_other', optionIds: draft.picked, otherText: written }
    }

    if (draft.picked.length > 0) {
      return { kind: 'multi', optionIds: draft.picked }
    }

    return written.length === 0 ? undefined : { kind: 'other', text: written }
  }

  if (written.length > 0) {
    return { kind: 'other', text: written }
  }

  const optionId = draft.picked[0]

  return optionId === undefined ? undefined : { kind: 'single', optionId }
}

/**
 * 整组装进一份答复；任何一道答不出来，整份都不成交（凑不齐是调用方的错，这里不替它遮）。跳过一次也是答复；
 * method 与 note 原样带上 —— 官方今天不读 note、也不转发 'click'，那是上游的取舍，不是我们少记的理由。
 */
export function responseOf(
  group: { readonly questionId: string; readonly questions: readonly QuestionItem[] },
  drafts: Readonly<Record<string, QuestionDraft>>,
  method: QuestionAnswerMethod | undefined,
  note: string,
): QuestionResponse | undefined {
  const answers: QuestionAnswer[] = []

  for (const item of group.questions) {
    const answer = answerOf(item, drafts[item.id] ?? EMPTY_DRAFT)

    if (answer === undefined) {
      return undefined
    }

    answers.push({ questionId: item.id, answer })
  }

  const trimmed = note.trim()

  return {
    questionId: group.questionId,
    answers,
    ...(method === undefined ? {} : { method }),
    ...(trimmed.length === 0 ? {} : { note: trimmed }),
  }
}
