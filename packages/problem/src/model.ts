/* Domain-owned vocabulary. The native bridge translates generated wire DTOs at the process boundary. */
export type Category =
  | 'validation'
  | 'configuration'
  | 'permission'
  | 'transport'
  | 'protocol'
  | 'persistence'
  | 'integrity'
  | 'cancelled'
  | 'internal'
export type Code =
  | 'contractDecodeFailed'
  | 'capabilityMissing'
  | 'agentUnavailable'
  | 'agentStartFailed'
  | 'turnRejected'
  | 'deliveryUnknown'
  | 'permissionDenied'
  | 'workspaceUnavailable'
  | 'ledgerAppendFailed'
  | 'ledgerCorrupted'
  | 'cancelled'
  | 'internal'
  | 'requestInvalid'
  | 'resourceMissing'
  | 'fileUnavailable'
  | 'settingsUnavailable'
  | 'assetRejected'
  | 'pluginRejected'
  | 'agentRejected'
  | 'gitRejected'
  | 'hostFailed'
export type DiagnosticId = string
export type Problem = {
  code: Code
  category: Category
  retryability: Retryability
  /**
   * 文案键，不是句子：文案归前端目录。
   */
  userMessageKey: string
  diagnosticId: DiagnosticId
  details: Partial<{ [key in string]: string }>
}
export type Retryability = 'no' | 'afterDelay' | 'afterUserAction'
