import type {
  ExtensionAskDialogQuestion,
  ExtensionAskDialogResult,
  ExtensionAskDialogResultItem,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types'
import type { Interaction } from '@poietica/engine'
import type { InteractionDraft } from './broker'

/** 产品题组里的一道题（Interaction 的 question 支，单一事实来源是 engine 的值对象） */
export type EngineQuestionGroup = Extract<Interaction, { kind: 'question' }>['questions'][number]

/**
 * omp 的 ask 题组 ↔ 产品题组（12 页 §8.4，迁移 legacy questions.ts 的 askQuestionsOf / optionsOf /
 * answerPayloadOf）。
 *
 * 这一层是 omp 的形状边界：上游的题（选项只有标签，还带 preview / recommended 这些产品画不出的格）
 * 在这里折成产品形状，产品的答复在这里折回上游要的结果。折叠只此一处。
 *
 * 形状正本（omp 18.5.0，docs/omp-sdk-reference.md §J 与 pi-tui/overlays/ask-dialog.d.ts:10-46）：
 * - 请求 ExtensionAskDialogQuestion：id / question / header? / options[{label, description?, preview?}] /
 *   multi? / recommended?；由 tools/ask.ts:770-784 原样交给 uiContext.askDialog。
 * - 答复 ExtensionAskDialogResult：{kind:'submit', results:[…]} 或 {kind:'chat'}；每项 {id, question,
 *   options: string[], multi, selectedOptions: string[], customInput?, note?, timedOut?}，其中 options 与
 *   selectedOptions 都是**标签**。
 * - 收下之后的判据 tools/ask.ts:802-813：每题结果的 id 必须等于题 id，否则抛「Ask dialog returned
 *   results that do not match the requested question order」。
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

/**
 * 上游那组题 → 产品题组；认不出的题如实丢掉，不编一道空的（空题组会让提问面板无从画起）。
 *
 * 号由这里签发：上游的选项没有号，而产品的答案是按号回来的，所以号与标签的对应必须在同一处产生
 * （就在本文件里），否则答案翻译不回上游。
 */
export function askQuestionsOf(questions: readonly unknown[]): EngineQuestionGroup[] {
  const asked: EngineQuestionGroup[] = []

  for (const [index, raw] of questions.entries()) {
    if (typeof raw !== 'object' || raw === null) continue
    const question = raw as UpstreamQuestion
    if (typeof question.question !== 'string') continue

    // 上游的 id 可选（arkType 里是必填，但线上可能是别的扩展报来的）；缺席时按序号编一个，
    // 答案翻译用的是同一份号，所以自洽。
    const id = typeof question.id === 'string' && question.id !== '' ? question.id : `q${index}`

    asked.push({
      id,
      prompt: question.question,
      multiple: question.multi === true,
      // 上游恒定允许自答（tools/ask.ts 的 OTHER_OPTION 恒在列），所以恒真。
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
      // 号在这一题内唯一即可：产品按号勾选，翻译时按同一个号取回标签。
      // 用**收下之后的位次**而不是原始下标，认不出的选项因此不会在号上留洞。
      id: `o${mapped.length}`,
      label: option.label,
      description: description === '' ? null : description,
    })
  }

  return mapped
}

/** 产品题组 → 交互草稿（kind 为 question） */
export function questionInteraction(questions: readonly EngineQuestionGroup[]): InteractionDraft {
  return { kind: 'question', questions: [...questions] }
}

/**
 * 产品对某一题的答复：勾了哪几个选项号 + 自己写了什么（engine 的 InteractionAnswer.question 形状）。
 * 单选就是 selected 恰好一项；「跳过这题」就是 selected 空、custom 空。
 */
type ProductAnswer = { readonly selected: readonly string[]; readonly custom: string | null }

interface ProductResponse {
  readonly answers?: Record<string, ProductAnswer>
  /**
   * 产品的备注在 engine 的形状里还没有一格；这里仍然收下它（挂在第一题上），
   * 这样旧的一路若带上备注仍然只出现一次。engine 补上这一格之前，这条读取是兼容而非必需。
   */
  readonly note?: unknown
}

/**
 * 产品的答复 → 上游要的结果。`undefined` 就是「没人答」：撤下整组与答不出来的形状都走它，
 * omp 把 undefined 读成用户取消（tools/ask.ts:786-789 的 `if (!richResult)`），那正是撤下该有的结局。
 *
 * 两处有损，都在这里说清：
 * - 「跳过这题」在单选里折成空选 + 无自答。对多选那是合法的「一个都不选」；对**只有一道题的单选**，
 *   上游把它读成取消（ask.ts:835-841 的官方注释），于是整组作罢、那一轮以取消收场。这与「人明说了
 *   不答」是同一个结局，但不只是一道题空着。
 * - 产品的备注是**整组**一格，上游的 note 是**每题**一格：挂在第一题上，让它只出现一次。
 *   分散到每题会在模型上下文里重复同一句话。
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

/**
 * 一条答复折成上游的「勾了哪几个标签 + 自己写了什么」。
 * 号换不回标签时返回 undefined（宁可当作没答，也不替人挑一枚）—— 这就是 legacy 的按号取标签，
 * 只是产品的答复形状从「五种 kind」收成了「一小撮号 + 一段自答」。
 */
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

/** 上游 askDialog 的原样形状；本层只用来钉住 answers 折出来的那一支 */
export type EngineAskDialogQuestion = ExtensionAskDialogQuestion
