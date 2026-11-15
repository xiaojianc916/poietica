import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { EngineErrorCode } from '@poietica/runtime-protocol'
import { outcomeOf, toEngineError } from '../errors'

describe('toEngineError', () => {
  test('已经是 AppError 时原样返回（不包一层）', () => {
    const original = new AppError('x.y', 'm')
    expect(toEngineError(original)).toBe(original)
  })

  test('按 omp 的报错形状分类：busy、缺 key、模型不存在、带状态码、超时/连接重置、其它', () => {
    const busy = Object.assign(new Error('busy'), { name: 'AgentBusyError' })
    expect(toEngineError(busy).code).toBe(EngineErrorCode.busy)

    const noKey = Object.assign(new Error('No API key configured for anthropic'), { provider: 'anthropic' })
    expect(toEngineError(noKey).code).toBe(EngineErrorCode.providerNotConfigured)
    expect(toEngineError(noKey).data).toEqual({ provider: 'anthropic' })

    expect(toEngineError(new Error('model not found: foo/bar')).code).toBe(EngineErrorCode.modelNotFound)

    const rateLimited = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 })
    expect(toEngineError(rateLimited).code).toBe(EngineErrorCode.upstream)
    expect(toEngineError(rateLimited).message).toBe('Rate limit exceeded')
    expect(toEngineError(rateLimited).data).toEqual({ status: 429 })
    expect(toEngineError(new Error('socket hang up')).code).toBe(EngineErrorCode.upstream)
    expect(toEngineError(new Error('request timed out')).code).toBe(EngineErrorCode.upstream)

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
