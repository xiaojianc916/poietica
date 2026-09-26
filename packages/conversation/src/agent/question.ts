/*
 * 题号与选项号由桥签发，全程不解析（ADR 0054）：agent 自己的题只有标签，号是桥现编的，
 * 答复按同一个号回来 —— 这一侧既不给号赋予含义，也不从号里推标签。
 */

export interface QuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly body?: string
  readonly options: readonly QuestionOption[]
  readonly multiSelect: boolean
  readonly allowOther: boolean
  readonly otherLabel?: string
  readonly otherDescription?: string
}

/** 判别式与分支名是这条答复协议的取值域；正本 crates/agent-client 的 QuestionAnswer。 */
export type QuestionChoice =
  | { readonly kind: 'single'; readonly optionId: string }
  | { readonly kind: 'multi'; readonly optionIds: readonly string[] }
  | { readonly kind: 'other'; readonly text: string }
  | {
      readonly kind: 'multi_with_other'
      readonly optionIds: readonly string[]
      readonly otherText: string
    }
  | { readonly kind: 'skipped' }

export interface QuestionAnswer {
  readonly questionId: string
  readonly answer: QuestionChoice
}

/** 官方把 click 丢掉，但它在 wire 上是合法值；如实上报，不改报。 */
export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key' | 'click'

export interface QuestionResponse {
  readonly questionId: string
  readonly answers: readonly QuestionAnswer[]
  readonly method?: QuestionAnswerMethod
  /** 官方 server 今天收下但不读（routes/questions.ts 的 toInProcessResponse）；它是官方契约的一部分。 */
  readonly note?: string
}
