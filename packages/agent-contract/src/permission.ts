/** 客户端为一次 KAP approval 合成的可选决策。 */
export interface PermissionOption {
  readonly optionId: string
  readonly name: string
  readonly kind: 'allow_always' | 'allow_once' | 'reject_once'
}

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
