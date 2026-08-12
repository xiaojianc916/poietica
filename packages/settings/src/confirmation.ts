export interface ConfirmationRequest {
  readonly cancelLabel: string
  readonly message: string
  readonly okLabel: string
  readonly title: string
}

export type ConfirmationPort = (request: ConfirmationRequest) => Promise<boolean>
