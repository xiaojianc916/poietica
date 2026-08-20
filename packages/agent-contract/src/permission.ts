/**
 * 审批的答复词。就是 kap 的 approvalResponseSchema.decision。
 *
 * 取值域由协议封闭，所以它是一个联合类型，不是一张由客户端合成的选项表 ——
 * kap 的审批请求里没有选项这个对象。
 */
export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled'

/** 「这条会话都照此办理」。kap 只有这一个取值。 */
export type ApprovalScope = 'session'

/** 人能给出的那两个。cancelled 是没有人答时这一侧的收场，不是一次答复。 */
export type ApprovalAnswer = Exclude<ApprovalDecision, 'cancelled'>

/**
 * 用户希望下一次会话采用的批准姿态。
 *
 * 这是产品持久状态，不是 wire 会话状态。宿主决定如何保存，领域层只声明
 * 唯一读写端口。
 */
export interface PermissionPosturePort {
  readonly read: () => string | undefined
  readonly write: (value: string) => void
}
