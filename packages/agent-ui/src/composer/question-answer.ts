import type {
  QuestionAnswerMethod,
  QuestionChoice,
  QuestionItem,
  QuestionResponse,
} from '@poietica/agent-contract'

/*
 * 面板上的一份草稿，怎么变成协议的一份答复。
 *
 * 这里全是纯函数：面板只管把点击与键盘记成草稿；草稿怎么折成一条
 * QuestionChoice、整组装进一份 QuestionResponse、一条答复怎么读回一句话，
 * 都在这一个文件里。协议形状的对账因此只有一个地方 —— 编译器看着
 * QuestionChoice，测试看着这个文件。
 */

/** 一道题此刻的草稿。 */
export interface QuestionDraft {
  /** 已勾的选项 id，按勾选的先后。 */
  readonly picked: readonly string[]
  /** 自选那一格写下的字。 */
  readonly written: string
  /** 这一题被跳过。 */
  readonly skipped: boolean
}

export const EMPTY_DRAFT: QuestionDraft = { picked: [], written: '', skipped: false }

/**
 * 一道题的草稿折成协议的一条答复；还答不出来时是 undefined。
 *
 * 判据只有一份：跳过压过一切；自选项写了字就算数，多选时与勾选项并立。
 * 单选只留最后勾的那一枚 —— 那一枚由面板在写草稿时就裁好，这里不猜。
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
 * 整组草稿装进协议的一份答复；任何一道答不出来，整份都不成交。
 *
 * 凑不齐是调用方的错 —— 面板在凑齐之前不该交出 send，这里不替它遮。跳过的题
 * 也在答复里：跳过一次也是答复。method 与 note 原样带上：官方今天不读 note、
 * 也不转发 'click'，那是上游的取舍，不是我们少记的理由。
 */
export function responseOf(
  group: { readonly questionId: string; readonly questions: readonly QuestionItem[] },
  drafts: Readonly<Record<string, QuestionDraft>>,
  method: QuestionAnswerMethod | undefined,
  note: string,
): QuestionResponse | undefined {
  const answers: Record<string, QuestionChoice> = {}

  for (const item of group.questions) {
    const answer = answerOf(item, drafts[item.id] ?? EMPTY_DRAFT)

    if (answer === undefined) {
      return undefined
    }

    answers[item.id] = answer
  }

  const trimmed = note.trim()

  return {
    questionId: group.questionId,
    answers,
    ...(method === undefined ? {} : { method }),
    ...(trimmed.length === 0 ? {} : { note: trimmed }),
  }
}

/** 一个选项 id 读回它的标签；对不上题时照原文，不编。 */
export function labelOf(item: QuestionItem, optionId: string): string {
  const option = item.options.find((candidate) => candidate.id === optionId)

  return option === undefined ? optionId : option.label
}

/** 一条答复读成一句话，给落定卡用。 */
export function describeAnswer(item: QuestionItem, answer: QuestionChoice): string {
  switch (answer.kind) {
    case 'single':
      return labelOf(item, answer.optionId)
    case 'multi':
      return answer.optionIds.map((optionId) => labelOf(item, optionId)).join('、')
    case 'other':
      return answer.text
    case 'multi_with_other':
      return [
        ...answer.optionIds.map((optionId) => labelOf(item, optionId)),
        answer.otherText,
      ].join('、')
    case 'skipped':
      return '跳过'
  }
}
