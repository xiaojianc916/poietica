/*
 * AskUserQuestion —— 协议层。
 *
 * ACP 本身没有「提问」。一道题在 wire 上就是一个 session/request_permission，
 * agent 借选项的命名与 kind 把题面编进去。本文件描述的是这个通用形状，具体
 * 用什么命名空间由调用方交进来的方言决定 —— 本文件不认识任何一家 agent。
 *
 * 以目前唯一登记的方言（kimi-code 的 ACP adapter）为例，一道题长这样：
 *
 *   options: [
 *     { optionId: 'q0_opt_0', name: '<label>', kind: 'allow_once' },
 *     ...
 *     { optionId: 'q0_skip',  name: 'Skip',    kind: 'reject_once' },   // 自动追加
 *   ]
 *
 * 回包只能带一个 optionId；回 skip 选项或 cancelled 都被 agent 解成"这道题跳过"。
 * 因此：
 *
 *   - 不做多选：回包带不回去。
 *   - 不做自由填写：工具侧没有这个通道。
 *   - 面板按 1/N 分页建模。今天 N 恒为 1；q(\d+)_ 命名空间是上游为多题预留的，
 *     等它放开，同一套 UI 直接生效，wire format 不变。
 */

import type { ToolCallContent } from '@poietica/agent-contract'
import { toToolCallView } from './tool-call-content'

export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * 认得出「向用户提问」的方言。
 *
 * 提问不是 ACP 的概念：协议只有 session/request_permission。哪个 agent 用
 * 什么形状把一道题塞进权限请求，是那个 agent 的方言，所以它是一张表而不是
 * 两条写死的正则 —— 接第二个 ACP agent 是加一行，不是改判据。
 */
export interface QuestionDialect {
  /** 匹配一个可选项，捕获 (题号, 选项号)。 */
  readonly option: RegExp
  /** 匹配「跳过这道题」，捕获 (题号)。 */
  readonly skip: RegExp
}

export type QuestionOptionId =
  | { readonly kind: 'option'; readonly questionIndex: number; readonly optionIndex: number }
  | { readonly kind: 'skip'; readonly questionIndex: number }

/** 解析 ACP optionId。不属于任何已知提问命名空间的一律返回 null。 */
export function parseQuestionOptionId(
  optionId: string,
  dialects: readonly QuestionDialect[],
): QuestionOptionId | null {
  for (const dialect of dialects) {
    const option = dialect.option.exec(optionId)

    if (option) {
      return {
        kind: 'option',
        questionIndex: Number(option[1]),
        optionIndex: Number(option[2]),
      }
    }

    const skip = dialect.skip.exec(optionId)

    if (skip) {
      return { kind: 'skip', questionIndex: Number(skip[1]) }
    }
  }

  return null
}

export interface QuestionChoice {
  readonly optionId: string
  readonly label: string
}

export interface QuestionCard {
  /** 这道题对应的那个 permission 请求；答案按 requestId 回。 */
  readonly requestId: string
  readonly prompt: string
  /** 短分类标签（上游 header，≤12 字符）。没有就是空串。 */
  readonly header: string
  readonly choices: readonly QuestionChoice[]
  /** 跳过这道题用的 optionId。上游保证有，缺失时为 undefined。 */
  readonly skipOptionId: string | undefined
}

export interface QuestionDeck {
  /** 题组锚定的工具调用；时间线卡片挂在同一处。 */
  readonly toolCallId: string
  readonly cards: readonly QuestionCard[]
}

/**
 * 一个 pending 请求像不像 AskUserQuestion。
 *
 * 判据是 optionId 的形状加上 ACP kind，不是工具名：工具名在不同 agent / 版本下
 * 写法不一，而方言的命名空间是 adapter 自己造的、在该 agent 内稳定的。
 */
export function isQuestionRequest(
  request: {
    readonly options: readonly { readonly optionId: string; readonly kind?: string }[]
  },
  dialects: readonly QuestionDialect[],
): boolean {
  if (request.options.length === 0) {
    return false
  }

  /*
   * 形状对得上还不够，语义也要对得上。
   *
   * 一次真正的授权请求（写文件、跑命令）里总带着 allow_always / reject_always，
   * 而一道题只有「选它」和「跳过」。只认命名空间的话，optionId 恰好撞上这套
   * 形状的授权请求会被摘出流、画成一道选择题 —— 用户以为在答题，实际是在
   * 批准写盘。kind 是 ACP 自己的分类，比任何一家的私有命名都权威。
   *
   * kind 缺席时不否决：题组构建阶段只带着 optionId 与文案，那一层的语义
   * 已经在上游按完整的 PermissionOption 判过一次了。
   */
  return request.options.every((option) => {
    const parsed = parseQuestionOptionId(option.optionId, dialects)

    if (parsed === null) {
      return false
    }

    if (option.kind === undefined) {
      return true
    }

    return parsed.kind === 'skip' ? option.kind === 'reject_once' : option.kind === 'allow_once'
  })
}

/**
 * 把同一个工具调用下的若干 pending 提问请求聚成一副题组。
 *
 * 按 questionIndex 排序；同一个 index 只保留第一个（上游今天只发 index 0，
 * 重复出现说明是新一轮提问，由调用方按 toolCallId 分流）。
 */
export function buildQuestionDeck(
  toolCallId: string,
  requests: readonly {
    readonly requestId: string
    readonly prompt: string
    readonly header?: string | undefined
    readonly options: readonly { readonly optionId: string; readonly label: string }[]
  }[],
  dialects: readonly QuestionDialect[],
): QuestionDeck | null {
  const seen = new Set<number>()
  const ordered: { index: number; card: QuestionCard }[] = []

  for (const request of requests) {
    /*
     * 单趟解析。此前同一批 optionId 最多过三遍正则：isQuestionRequest 全量
     * 一遍、首枚再一遍、choices 循环又一遍。语义逐条保持：题号取自首枚
     * （不问 kind），任一选项不可解析整单作废，seen.add 在 choices 检查
     * 之前（全 skip 的畸形请求照样消费题号）。
     */
    const choices: QuestionChoice[] = []
    let skipOptionId: string | undefined
    let index: number | undefined

    for (const option of request.options) {
      const parsed = parseQuestionOptionId(option.optionId, dialects)

      if (parsed === null) {
        index = undefined
        break
      }

      index ??= parsed.questionIndex

      if (parsed.kind === 'skip') {
        skipOptionId = option.optionId
        continue
      }

      choices.push({ optionId: option.optionId, label: option.label })
    }

    if (index === undefined || seen.has(index)) {
      continue
    }

    seen.add(index)

    if (choices.length === 0) {
      continue
    }

    ordered.push({
      index,
      card: {
        requestId: request.requestId,
        prompt: request.prompt,
        header: request.header ?? '',
        choices,
        skipOptionId,
      },
    })
  }

  if (ordered.length === 0) {
    return null
  }

  ordered.sort((a, b) => a.index - b.index)

  return { toolCallId, cards: ordered.map((entry) => entry.card) }
}

/** 面板提交产出的东西：每道题一条，跳过的题用它自己的 skip。 */
export interface QuestionAnswer {
  readonly requestId: string
  readonly optionId: string
}
/*
 * 一道题真正的题面。
 *
 * permission 帧的 title 是工具名而不是题面 —— 题面被塞进 toolCall.content 的第一
 * 段文本。所以凡是要显示「问了什么」的地方都必须走这里；读 title 只能读到工具名。
 *
 * 内容怎么拆，这里不自己写。此前它手搓了一遍 unknown 的逐层收窄（判 object、判
 * type === 'content'、再判 inner、再判 text），而同一件事在 tool-call-content 里
 * 已经有一份照着协议判别式走的实现 —— 一个 as 都不需要。两份解析器读同一个 wire
 * 形状，正是这条规则自己被违反的地方：权限卡那边走的就是另一份。
 *
 * 换过来还顺带省下一次解析：同一道题的 content 在 surface 的题组 useMemo 与流里那
 * 张结果卡上各读一次，而缓存的键就是 content 数组本身。
 *
 * trim 留在这里：拆分那一层交回的是原文，而空白构不成一句题面。
 *
 * 参数仍按结构收，不绑 PermissionItem：前提只有「有个 title、可能有个
 * toolCall.content」。
 */

interface QuestionPromptSource {
  readonly title: string
  readonly toolCall?:
    | { readonly content?: readonly ToolCallContent[] | null | undefined }
    | undefined
}

export function readQuestionPrompt(request: QuestionPromptSource): string {
  for (const part of toToolCallView(request.toolCall?.content).parts) {
    if (part.type !== 'text') {
      continue
    }

    const text = part.text.trim()

    if (text.length > 0) {
      return text
    }
  }

  return request.title
}
