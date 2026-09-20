/** 审批的答复词，即 kap 的 approvalResponseSchema.decision；取值域由协议封闭。 */
export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled'

export type ApprovalScope = 'session'

export interface ApprovalAnswer {
  readonly decision: Exclude<ApprovalDecision, 'cancelled'>
  readonly scope?: ApprovalScope
  readonly selectedLabel?: string
  readonly feedback?: string
}

export interface PermissionPosturePort {
  readonly read: () => string | undefined
  readonly write: (value: string) => void
}
