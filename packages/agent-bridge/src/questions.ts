/*
 * omp 的 ask 工具题目 ↔ 产品题组。
 *
 * 这一层是 omp 的形状边界：上游的题（选项只有标签、还带 preview / recommended 这些
 * 产品画不出的字段）在这里折成产品形状，产品的答复在这里折回上游要的结果。
 * 折叠只此一处 —— 让 Rust 认 omp 的字段名就是把 agent 专属知识放进通用层（AGENTS.md §4）。
 *
 * 形状正本（18.3.0）：
 * - 请求 tools/ask.ts:60-72 的 arkType（id / question / header? / options[{label,
 *   description?, preview?}] / multi? / recommended?），由 tools/ask.ts:926-940 原样
 *   交给 uiContext.askDialog。
 * - 答复 @oh-my-pi/pi-tui 的 overlays/ask-dialog：{kind:'submit', results:[...]} 或
 *   {kind:'chat'}；每项 {id, question, options: string[], multi, selectedOptions: string[],
 *   customInput?, note?, timedOut?}，其中 options / selectedOptions 都是**标签**。
 * - 收下之后的判据 tools/ask.ts:941-1020：每题结果的 id 必须等于题 id（否则抛
 *   「results that do not match the requested question order」）。
 */

import type { AskedQuestion } from './protocol.ts'

/** 上游一道题的形状，只列我们读的格。 */
interface UpstreamQuestion {
  readonly id?: unknown
  readonly question?: unknown
  readonly header?: unknown
  readonly options?: unknown
  readonly multi?: unknown
}

interface UpstreamOption {
  readonly label?: unknown
  readonly description?: unknown
}

/**
 * 上游那组题 → 产品题组；认不出的题如实丢掉，不编一道空的。
 *
 * 号由这里签发：上游的选项没有号，而产品的答案是按号回来的，所以号与标签的对应
 * 必须在同一处产生（就在这个函数里），否则答案翻译不回上游。
 */
export function askQuestionsOf(questions: unknown): AskedQuestion[] {
  if (!Array.isArray(questions)) {
    return []
  }

  const asked: AskedQuestion[] = []

  for (const [index, raw] of questions.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      continue
    }

    const question = raw as UpstreamQuestion

    if (typeof question.question !== 'string') {
      continue
    }

    // 上游的 id 可选（arkType 里是必填，但线上可能是别的扩展报来的）；缺席时按序号编一个，
    // 答案翻译用的是同一份号，所以自洽。
    const id = typeof question.id === 'string' && question.id !== '' ? question.id : `q${index}`

    asked.push({
      id,
      question: question.question,
      ...(typeof question.header === 'string' && question.header.trim() !== ''
        ? { header: question.header.trim() }
        : {}),
      options: optionsOf(question.options),
      multiSelect: question.multi === true,
      // 上游恒定允许自答（tools/ask.ts:42 的 OTHER_OPTION 恒定在列），所以恒真。
      allowOther: true,
    })
  }

  return asked
}

function optionsOf(options: unknown): AskedQuestion['options'] {
  if (!Array.isArray(options)) {
    return []
  }

  const mapped: { id: string; label: string; description?: string }[] = []

  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) {
      continue
    }

    const option = raw as UpstreamOption

    if (typeof option.label !== 'string' || option.label === '') {
      continue
    }

    const trimmed = option.description?.toString().trim()

    mapped.push({
      // 号在这一题内唯一即可：产品按号勾选，翻译时按同一个号取回标签。
      // 用**收下之后的位次**而不是原始下标，认不出的选项因此不会在号上留洞。
      id: `o${mapped.length}`,
      label: option.label,
      ...(trimmed === undefined || trimmed === '' ? {} : { description: trimmed }),
    })
  }

  return mapped
}

/** 上游要的一道题的结果；`options` 与 `selectedOptions` 都是标签。 */
interface UpstreamResult {
  readonly id: string
  readonly question: string
  readonly options: string[]
  readonly multi: boolean
  readonly selectedOptions: string[]
  readonly customInput?: string
  readonly note?: string
}

/** 产品的一条答复，与 question.rs 的 QuestionAnswer 逐字对应。 */
type ProductAnswer =
  | { readonly kind: 'single'; readonly optionId: string }
  | { readonly kind: 'multi'; readonly optionIds: readonly string[] }
  | { readonly kind: 'other'; readonly text: string }
  | {
      readonly kind: 'multi_with_other'
      readonly optionIds: readonly string[]
      readonly otherText: string
    }
  | { readonly kind: 'skipped' }

interface ProductResponse {
  readonly answers?: Record<string, ProductAnswer>
  readonly method?: unknown
  readonly note?: unknown
}

/**
 * 产品的答复 → 上游要的结果。
 *
 * `undefined` 就是「没人答」：撤下整组（answers 空）与答不出来的形状都走它。
 * 上游把 undefined 读成取消（tools/ask.ts:946-949 的 `if (!richResult)`），那正是
 * 撤下该有的结局。
 *
 * 两处有损，都在这里说清：
 * - 「跳过这题」在单选里折成空选 + 无自答。对多选那是合法的「一个都不选」；对**只有
 *   一道题的单选**，上游把它读成取消（ask.ts:984-992，官方注释写明了这个分野）——
 *   于是整组作罢、那一轮以取消收场。这与「人明说了不答」是同一个结局，但要知道它
 *   不只是一道题空着。
 * - 产品的备注是**整组**一格，上游的 note 是**每题**一格：挂在第一题上，让它只出现一次。
 *   分散到每题会在模型上下文里重复同一句话。
 */
export function answerPayloadOf(
  questions: readonly AskedQuestion[],
  response: unknown,
): { readonly kind: 'submit'; readonly results: readonly UpstreamResult[] } | undefined {
  if (typeof response !== 'object' || response === null) {
    return undefined
  }

  const answers = (response as ProductResponse).answers

  if (answers === undefined || Object.keys(answers).length === 0) {
    return undefined
  }

  const note = noteOf((response as ProductResponse).note)
  const results: UpstreamResult[] = []

  for (const [index, question] of questions.entries()) {
    const answer = answers[question.id]

    if (answer === undefined) {
      return undefined
    }

    const folded = labelsOf(question, answer)

    if (folded === undefined) {
      return undefined
    }

    results.push({
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: question.multiSelect,
      selectedOptions: folded.labels,
      ...(folded.text === undefined ? {} : { customInput: folded.text }),
      ...(note === undefined || index > 0 ? {} : { note }),
    })
  }

  return { kind: 'submit', results }
}

/** 一条答复折成上游的「勾了哪几个标签 + 自己写了什么」。 */
function labelsOf(
  question: AskedQuestion,
  answer: ProductAnswer,
): { readonly labels: string[]; readonly text?: string } | undefined {
  switch (answer.kind) {
    case 'single': {
      const label = labelOf(question, answer.optionId)

      return label === undefined ? undefined : { labels: [label] }
    }
    case 'multi': {
      const labels = labelsFor(question, answer.optionIds)

      return labels === undefined ? undefined : { labels }
    }
    case 'other':
      return answer.text === '' ? undefined : { labels: [], text: answer.text }
    case 'multi_with_other': {
      const labels = labelsFor(question, answer.optionIds)

      if (labels === undefined || answer.otherText === '') {
        return undefined
      }

      return { labels, text: answer.otherText }
    }
    case 'skipped':
      return { labels: [] }
    default:
      return undefined
  }
}

function labelsFor(question: AskedQuestion, optionIds: readonly string[]): string[] | undefined {
  const labels: string[] = []

  for (const optionId of optionIds) {
    const label = labelOf(question, optionId)

    if (label === undefined) {
      return undefined
    }

    labels.push(label)
  }

  return labels
}

function labelOf(question: AskedQuestion, optionId: string): string | undefined {
  return question.options.find((option) => option.id === optionId)?.label
}

function noteOf(note: unknown): string | undefined {
  if (typeof note !== 'string') {
    return undefined
  }

  const trimmed = note.trim()

  return trimmed === '' ? undefined : trimmed
}
