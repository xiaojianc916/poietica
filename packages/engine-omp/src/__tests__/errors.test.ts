import { describe, expect, test } from 'bun:test'
import { EngineErrorCode } from '@poietica/engine'
import { AppError } from '@poietica/foundation'
import { outcomeOf, toEngineError } from '../errors'

describe('toEngineError', () => {
  test('已经是 AppError 时原样返回', () => {
    const original = new AppError('x.y', 'm')
    expect(toEngineError(original)).toBe(original)
  })

  test('AgentBusyError → engine.busy', () => {
    const error = Object.assign(new Error('busy'), { name: 'AgentBusyError' })
    expect(toEngineError(error).code).toBe(EngineErrorCode.busy)
  })

  test('没有 API key 一类 → engine.provider_not_configured，并带上 provider', () => {
    const error = Object.assign(new Error('No API key configured for anthropic'), { provider: 'anthropic' })
    const mapped = toEngineError(error)
    expect(mapped.code).toBe(EngineErrorCode.providerNotConfigured)
    expect(mapped.data).toEqual({ provider: 'anthropic' })
  })

  test('模型不存在 → engine.model_not_found', () => {
    expect(toEngineError(new Error('model not found: foo/bar')).code).toBe(EngineErrorCode.modelNotFound)
  })

  test('带状态码 → engine.upstream_error，message 为服务商原文', () => {
    const error = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 })
    const mapped = toEngineError(error)
    expect(mapped.code).toBe(EngineErrorCode.upstream)
    expect(mapped.message).toBe('Rate limit exceeded')
    expect(mapped.data).toEqual({ status: 429 })
  })

  test('message 提到超时/连接重置 → engine.upstream_error', () => {
    expect(toEngineError(new Error('socket hang up')).code).toBe(EngineErrorCode.upstream)
    expect(toEngineError(new Error('request timed out')).code).toBe(EngineErrorCode.upstream)
  })

  test('其它 → kernel.internal', () => {
    expect(toEngineError(new Error('???')).code).toBe('kernel.internal')
    expect(toEngineError('string').code).toBe('kernel.internal')
  })
})

describe('outcomeOf', () => {
  test('aborted → cancelled；error → failed 带 message；其它 → completed', () => {
    expect(outcomeOf({ stopReason: 'aborted' })).toEqual({ outcome: 'cancelled', message: null })
    expect(outcomeOf({ stopReason: 'error', errorMessage: '炸了' })).toEqual({ outcome: 'failed', message: '炸了' })
    expect(outcomeOf({ stopReason: 'endTurn' })).toEqual({ outcome: 'completed', message: null })
    expect(outcomeOf(undefined)).toEqual({ outcome: 'completed', message: null })
  })
})
