import type { InteractionId } from './ids'

/** `plan`：计划模式产出的计划卡片（批准 / 驳回 / 要求修改），与审批、提问并列的第三种交互。 */
export type InteractionKind = 'approval' | 'question' | 'plan'

export type InteractionState = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed'

/*
 * 交互载荷按种类判别（Q1-C）。这是词表自己的形状，不是引擎的 `Interaction` 原样塞进来：
 * 映射只在引擎一侧做一次（`@poietica/engine` 的 `interactionCardOf`），界面按类型读，不再靠 `Reflect.get` 猜字段。
 * 请求在两种状态下都在：答复那一次 upsert 整条替换，从前只带答复，题面与计划正文就在收口时丢了。
 */

/** 卡片的主语是 `toolName`；`detail` 是上游算好的那一段（`Command: rm -rf …` 这类多行原文），可能为空串。 */
export interface ApprovalRequest {
  readonly toolName: string
  readonly title: string
  readonly detail: string
  readonly allowSessionScope: boolean
}

export interface PlanRequest {
  readonly title: string
  /** 计划文件的 `local://` 路径；批准后它作为参考路径交回会话。 */
  readonly planFilePath: string
  /** 计划正文；读文件失败时如实为空串。 */
  readonly planMarkdown: string
}

export interface InteractionQuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** 题号与选项号由引擎签发，界面全程不解析；答复按这两个号回来。 */
export interface InteractionQuestion {
  readonly id: string
  readonly prompt: string
  readonly multiple: boolean
  readonly allowCustom: boolean
  readonly options: readonly InteractionQuestionOption[]
}

export interface QuestionRequest {
  readonly questions: readonly InteractionQuestion[]
}

export interface ApprovalResponse {
  readonly decision: 'approve' | 'reject'
  readonly scope: 'once' | 'session'
  readonly feedback?: string
}

export interface PlanResponse {
  readonly decision: 'approve' | 'reject' | 'revise'
  readonly feedback?: string
}

/** 一题的答复：勾了哪几个选项号 + 自己写了什么；两样都空就是「跳过这题」。 */
export interface QuestionAnswerValue {
  readonly selected: readonly string[]
  readonly custom?: string
}

/** 键是题号（`InteractionQuestion.id`）。 */
export interface QuestionResponse {
  readonly answers: Readonly<Record<string, QuestionAnswerValue>>
}

interface InteractionBase {
  readonly interactionId: InteractionId
  readonly toolCallId?: string
  readonly state: InteractionState
}

/** 撤下、超时、取消这一轮都没有答复：`response` 缺席，终态由 `state` 说。 */
export interface ApprovalInteraction extends InteractionBase {
  readonly interactionKind: 'approval'
  readonly request: ApprovalRequest
  readonly response?: ApprovalResponse
}

export interface PlanInteraction extends InteractionBase {
  readonly interactionKind: 'plan'
  readonly request: PlanRequest
  readonly response?: PlanResponse
}

export interface QuestionInteraction extends InteractionBase {
  readonly interactionKind: 'question'
  readonly request: QuestionRequest
  readonly response?: QuestionResponse
}

export type TranscriptInteraction = ApprovalInteraction | PlanInteraction | QuestionInteraction
