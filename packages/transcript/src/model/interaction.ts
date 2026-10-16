import type { InteractionId } from './ids'

/**
 * `plan`：计划模式产出的计划卡片（批准 / 驳回 / 要求修改），与审批、提问并列的第三种交互。
 * `confirm` / `select` / `input`：扩展与工具经 omp 的 `ctx.ui` 发来的三类单问（是否 / 单选 / 一句话），
 * 各有自己的卡片（Q1-E）。从前按审批画，界面只会答 `approval`，引擎按种类对不上就拒收 —— 时间线上答不了。
 */
export type InteractionKind = 'approval' | 'question' | 'plan' | 'confirm' | 'select' | 'input'

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

export interface ConfirmRequest {
  readonly title: string
  /** 那句要人点头的话；可能为空串。 */
  readonly message: string
}

export interface SelectRequest {
  readonly title: string
  /** 选项原文；答复回的就是其中一条原文（omp 的 `select` 按原文认）。 */
  readonly options: readonly string[]
}

export interface InputRequest {
  readonly title: string
  /** 输入框里的提示（`editor` 是预填正文）；没有就缺席。 */
  readonly placeholder?: string
  /** `editor` 发来的是多行，`input` 是一行。 */
  readonly multiline: boolean
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

/** `true` 是确认，`false` 是不确认。 */
export interface ConfirmResponse {
  readonly value: boolean
}

/** 选中的那条原文；缺席是答了「不选」。 */
export interface SelectResponse {
  readonly value?: string
}

/** 写下的那句；缺席是答了「不填」。 */
export interface InputResponse {
  readonly value?: string
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

export interface ConfirmInteraction extends InteractionBase {
  readonly interactionKind: 'confirm'
  readonly request: ConfirmRequest
  readonly response?: ConfirmResponse
}

export interface SelectInteraction extends InteractionBase {
  readonly interactionKind: 'select'
  readonly request: SelectRequest
  readonly response?: SelectResponse
}

export interface InputInteraction extends InteractionBase {
  readonly interactionKind: 'input'
  readonly request: InputRequest
  readonly response?: InputResponse
}

export type TranscriptInteraction =
  | ApprovalInteraction
  | PlanInteraction
  | QuestionInteraction
  | ConfirmInteraction
  | SelectInteraction
  | InputInteraction
