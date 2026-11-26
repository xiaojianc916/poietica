import { fieldQuestions as fieldQuestionsOf, type HtmlFormData } from '@oh-my-pi/pi-tui/html-form/data'
import type { ExtensionAskDialogResult, ExtensionAskDialogResultItem } from '@poietica/omp-types'
import type { Interaction } from '@poietica/runtime-protocol'
import type { InteractionDraft } from './broker'

export type EngineQuestionGroup = Extract<Interaction, { kind: 'question' }>['questions'][number]

/**
 * omp 的 ask 题组 ↔ 产品题组，折叠只此一处：上游的题只有标签，还带 preview / recommended 这些产品画不出的格。
 * 答复折回上游的形状是 `{kind:'submit', results:[{id, options: string[], selectedOptions: string[]}]}`，
 * 两处 options 都是**标签**；上游要求每题结果的 id 等于题 id，否则整组作废。
 */

/** 上游一道题里我们读得懂的格（认不出的当缺席，不当错） */
interface UpstreamQuestion {
  readonly id?: unknown
  readonly question?: unknown
  readonly options?: unknown
  readonly multi?: unknown
}

interface UpstreamOption {
  readonly label?: unknown
  readonly description?: unknown
}

/** 认不出的题如实丢掉，不编一道空的（空题组会让提问面板无从画起）。号由这里签发：产品的答案是按号回来的 */
export function askQuestionsOf(questions: readonly unknown[]): EngineQuestionGroup[] {
  const asked: EngineQuestionGroup[] = []

  for (const [index, raw] of questions.entries()) {
    if (typeof raw !== 'object' || raw === null) continue
    const question = raw as UpstreamQuestion
    if (typeof question.question !== 'string') continue

    // 上游的 id 可选（线上可能是别的扩展报来的）；缺席时按序号编一个，答案翻译用的是同一份号
    const id = typeof question.id === 'string' && question.id !== '' ? question.id : `q${index}`

    asked.push({
      id,
      prompt: question.question,
      multiple: question.multi === true,
      allowCustom: true,
      options: optionsOf(question.options),
    })
  }

  return asked
}

function optionsOf(options: unknown): EngineQuestionGroup['options'] {
  if (!Array.isArray(options)) return []
  const mapped: { id: string; label: string; description: string | null }[] = []

  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) continue
    const option = raw as UpstreamOption
    if (typeof option.label !== 'string' || option.label === '') continue
    const description = typeof option.description === 'string' ? option.description.trim() : ''

    mapped.push({
      // 号在这一题内唯一即可；用**收下之后的位次**而不是原始下标，认不出的选项因此不会在号上留洞
      id: `o${mapped.length}`,
      label: option.label,
      description: description === '' ? null : description,
    })
  }

  return mapped
}

export function questionInteraction(questions: readonly EngineQuestionGroup[]): InteractionDraft {
  return { kind: 'question', questions: [...questions] }
}

/** 产品对某一题的答复：勾了哪几个选项号 + 自己写了什么；「跳过这题」就是 selected 空、custom 空 */
type ProductAnswer = { readonly selected: readonly string[]; readonly custom: string | null }

interface ProductResponse {
  readonly answers?: Record<string, ProductAnswer>
  /** 产品的备注在 engine 的形状里还没有一格；这里仍收下它（挂在第一题上），这样它只出现一次 */
  readonly note?: unknown
}

/**
 * 产品的答复 → 上游要的结果。`undefined` 就是「没人答」：撤下整组与答不出来的形状都走它，而 omp 把
 * undefined 读成用户取消，那正是撤下该有的结局。两处有损：「跳过这题」在只有一道题的单选里被上游读成
 * 取消、整组作罢；产品的备注是整组一格而上游的 note 是每题一格，挂在第一题上免得重复同一句话。
 */
export function askResultOf(
  questions: readonly EngineQuestionGroup[],
  response: unknown,
): ExtensionAskDialogResult | undefined {
  if (typeof response !== 'object' || response === null) return undefined

  const answers = (response as ProductResponse).answers
  if (answers === undefined || Object.keys(answers).length === 0) return undefined

  const note = noteOf((response as ProductResponse).note)
  const results: ExtensionAskDialogResultItem[] = []

  for (const [index, question] of questions.entries()) {
    const answer = answers[question.id]
    if (answer === undefined) return undefined

    const folded = labelsOf(question, answer)
    if (folded === undefined) return undefined

    results.push({
      id: question.id,
      question: question.prompt,
      options: question.options.map((option) => option.label),
      multi: question.multiple,
      selectedOptions: folded.labels,
      ...(folded.text === undefined ? {} : { customInput: folded.text }),
      ...(note === undefined || index > 0 ? {} : { note }),
    })
  }

  return { kind: 'submit', results }
}

/** 号换不回标签时返回 undefined（宁可当作没答，也不替人挑一枚） */
function labelsOf(
  question: EngineQuestionGroup,
  answer: ProductAnswer,
): { readonly labels: string[]; readonly text?: string } | undefined {
  const labels = labelsFor(question, answer.selected)
  if (labels === undefined) return undefined
  const text = answer.custom === null ? '' : answer.custom
  return text === '' ? { labels } : { labels, text }
}

function labelsFor(question: EngineQuestionGroup, optionIds: readonly string[]): string[] | undefined {
  const labels: string[] = []
  for (const optionId of optionIds) {
    const label = labelOf(question, optionId)
    if (label === undefined) return undefined
    labels.push(label)
  }
  return labels
}

function labelOf(question: EngineQuestionGroup, optionId: string): string | undefined {
  return question.options.find((option) => option.id === optionId)?.label
}

function noteOf(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined
  const trimmed = note.trim()
  return trimmed === '' ? undefined : trimmed
}

/*
 * ==== omp 19 的 HTML 表单 ask ====
 *
 * omp 18.18.3 起 ask 的入参是一张 HTML `<form>`（omp 的 `recoverAskHtml` 会把旧 `questions` 形状重建成表单），
 * 经 `ui.formDialog(html)` 呈现。产品没有 HTML 表单面板，只有题组卡片 —— 所以在这里把表单**折叠成题组**：
 * 解析用 omp 自己的 `parseHtmlForm`（radio/checkbox/select → 单选或多选题，text/textarea → 一句话题），
 * 题号用控件名、选项号用选项 value；答复按号折回 `HtmlFormData` 交回 omp（它按控件名读值）。
 */

/** 解析后的表单类型直接取 `fieldQuestions` 的入参：少一条 deep import，也不会与 omp 的形状漂开 */
type ParsedForm = Parameters<typeof fieldQuestionsOf>[0]
type FormField = ParsedForm['fields'][number]

/** 表单里的一个字段 → 产品的一题；控件名当题号（HTML 里 name 就是它的身份） */
function fieldQuestionOf(question: string, field: FormField): EngineQuestionGroup {
  if (field.kind === 'text') {
    return { id: field.name, prompt: question, multiple: false, allowCustom: true, options: [] }
  }
  return {
    id: field.name,
    prompt: question,
    multiple: field.multi,
    allowCustom: field.other,
    options: field.options
      .filter((option) => !option.disabled)
      .map((option) => ({
        /* 选项号就用 value：它与提交回来的值同一个产地，折回时不用二次映射 */
        id: option.value,
        label: option.value,
        description: null,
      })),
  }
}

/** 一张表单 → 产品题组。与 askQuestionsOf 同一个出口形状：控件有名字就是一题 */
export function formQuestionsOf(form: ParsedForm): EngineQuestionGroup[] {
  const questions = fieldQuestionsOf(form)
  return form.fields
    .filter((field) => field.name !== '')
    .map((field) => fieldQuestionOf(questions.get(field) ?? field.name, field))
}

/** 产品的题组答复 → 表单数据：只补人答的控件，任何一个都没答就当作取消 */
export function formResultOf(form: ParsedForm, response: unknown): HtmlFormData | undefined {
  const answers = answersOf(response)
  if (answers === undefined) return undefined

  const data: Record<string, string | number | string[]> = Object.create(null)
  let answered = 0

  for (const field of form.fields) {
    if (field.name === '') continue
    const value = formValueOf(field, answers[field.name])
    if (value === undefined) continue
    data[field.name] = value
    answered += 1
  }

  /* hidden 与预选的值 omp 会自己带上（defaultFormData），我们只补人答的那几格 */
  return answered === 0 ? undefined : data
}

/** 产品答复里的 `answers` 表；缺了它就是没答 */
function answersOf(response: unknown): Record<string, unknown> | undefined {
  if (typeof response !== 'object' || response === null) return undefined
  const answers = (response as { readonly answers?: unknown }).answers
  return typeof answers === 'object' && answers !== null ? (answers as Record<string, unknown>) : undefined
}

/** 一个控件的人答值；`undefined` 表示这一格没答（或答案形状不认识） */
function formValueOf(field: FormField, raw: unknown): string | number | string[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const selected = (raw as { readonly selected?: unknown }).selected
  const custom = (raw as { readonly custom?: unknown }).custom

  if (field.kind === 'text') {
    const text = typeof custom === 'string' ? custom : ''
    return text === '' ? undefined : text
  }

  const picked = Array.isArray(selected) ? selected.filter((value): value is string => typeof value === 'string') : []
  const own = field.options.filter((option) => picked.includes(option.value)).map((option) => option.value)
  const free = typeof custom === 'string' && custom !== '' ? custom : undefined
  /* 多选提交 value 数组，单选提交一个 value；other 的自由输入并进同一格 */
  if (!field.multi) return own[0] ?? free
  const values = free === undefined ? own : [...own, free]
  return values.length === 0 ? undefined : values
}
