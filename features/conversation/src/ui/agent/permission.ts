/** 取值域由协议封闭，正本是 crates/agent-client 的 permission.rs。 */
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
