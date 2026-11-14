/** 时间线目录（minimap / outline）的一格：号与正文的稳定摘要，不随投影重算而变。 */
export interface TurnMark {
  readonly turnId: string
  readonly admissionId: string
  readonly prompt: string
  readonly reply: string | null
}
