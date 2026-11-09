import { describe, expect, test } from 'bun:test'
import { RETRY_NOTICE_SOURCE, type RetryNotice, retryNoticeOf } from '../model/retry'

/* 重试那一格的 detail 只认一种形状：引擎按它写、界面按它读；形状不对一律 null，界面照普通提示画 */
describe('retryNoticeOf', () => {
  const retry: RetryNotice = { state: 'running', attempt: 2, maxAttempts: 5, errors: ['rate limited', 'overloaded'] }

  test('重试那一格读出进展', () => {
    expect(retryNoticeOf({ source: RETRY_NOTICE_SOURCE, detail: { retry } })).toEqual(retry)
  })

  test('来源不对、没有 detail 都是 null', () => {
    expect(retryNoticeOf({ source: 'compaction', detail: { retry } })).toBeNull()
    expect(retryNoticeOf({ source: RETRY_NOTICE_SOURCE })).toBeNull()
  })

  test('形状不对是 null：未知状态、次数不是非负整数、报错不是字符串', () => {
    expect(retryNoticeOf({ source: RETRY_NOTICE_SOURCE, detail: { retry: { ...retry, state: 'waiting' } } })).toBeNull()
    expect(retryNoticeOf({ source: RETRY_NOTICE_SOURCE, detail: { retry: { ...retry, attempt: 1.5 } } })).toBeNull()
    expect(retryNoticeOf({ source: RETRY_NOTICE_SOURCE, detail: { retry: { ...retry, errors: [42] } } })).toBeNull()
  })
})
