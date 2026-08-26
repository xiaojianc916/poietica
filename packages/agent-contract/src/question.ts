/**
 * 官方 kap 的提问契约，端口这一侧。
 *
 * 号一律不解析。题号与选项号是 kap 在每一次列举待答提问时现编的（kap-server 的
 * routes/questions.ts：题 q_{i}、选项 opt_{i}_{j}），所以界面拿到什么就交回什么。
 * 从号里读语义，正是这条链上一整代死代码的由来。
 */

/** 一题里的一个选项。 */
export interface QuestionOption {
  readonly id: string
  readonly label: string
  /** 这个选项自己的一句解释，agent 给了才有。 */
  readonly description?: string
}

/** 一道题。 */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  /** 题面之上的一行标题。 */
  readonly header?: string
  /** 题面之下的正文。 */
  readonly body?: string
  /** 两到四个。 */
  readonly options: readonly QuestionOption[]
  /** 这一题能不能多选。 */
  readonly multiSelect: boolean
  /** 这一题能不能自己写一句。 */
  readonly allowOther: boolean
  /** 「其他」那一栏怎么称呼。 */
  readonly otherLabel?: string
  /** 「其他」那一栏的说明。 */
  readonly otherDescription?: string
}

/** 一题答的是什么，五种。判别式与分支名取自 kap 的 questionAnswerSchema。 */
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

/** 一题一条答复。 */
export interface QuestionAnswer {
  readonly questionId: string
  readonly answer: QuestionChoice
}

/**
 * 人是怎么答的。
 *
 * 如实上报：官方把 click 丢掉，但它在 wire 上是合法值，改报成别的就是撒谎。
 */
export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key' | 'click'

/** 一整组的答复。 */
export interface QuestionResponse {
  readonly questionId: string
  readonly answers: readonly QuestionAnswer[]
  readonly method?: QuestionAnswerMethod
  /**
   * 整组的一行备注。
   *
   * 契约里有这一格，官方 server 今天收下但不读它（routes/questions.ts 的
   * toInProcessResponse 只把 answers 与 method 交给 agent）。留着是因为它是官方
   * 契约的一部分；它今天到不了 agent，这一点不该被界面的说明文案盖住。
   */
  readonly note?: string
}
