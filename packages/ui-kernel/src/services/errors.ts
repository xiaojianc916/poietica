import { isAppError } from '@poietica/foundation'

export interface DescribedError {
  readonly code: string
  readonly title: string
  readonly detail: string
}

/** 标题用契约里的默认文案（errorMessages[code]），详情用服务端 message；未知异常归为“操作失败” */
export function describeError(error: unknown, errorMessages: Readonly<Record<string, string>>): DescribedError {
  if (isAppError(error)) {
    return { code: error.code, title: errorMessages[error.code] ?? '操作失败', detail: error.message }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return { code: 'kernel.internal', title: '操作失败', detail }
}
