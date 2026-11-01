export type WorkBuddyClientErrorCode =
  | 'not_signed_in'
  | 'login_failed'
  | 'api_key_invalid'
  | 'usage_failed'
  | 'checkin_failed'
  | 'models_failed'
  | 'request_failed'

/** 适配层自己的错误；宿主把它翻成产品错误码，不把这一类直接甩给界面。 */
export class WorkBuddyClientError extends Error {
  constructor(
    readonly code: WorkBuddyClientErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.name = 'WorkBuddyClientError'
  }
}
