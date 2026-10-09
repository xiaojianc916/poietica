import { describe, expect, test } from 'bun:test'
import { AppError, isAppError, SerializedAppError, SystemErrorCode, toAppError } from '../errors'

describe('toAppError', () => {
  test('普通 Error → kernel.internal 且保留 message', () => {
    const error = toAppError(new Error('x'))
    expect(error.code).toBe(SystemErrorCode.internal)
    expect(error.message).toBe('x')
  })

  test('字符串 → message 为原字符串', () => {
    expect(toAppError('s').message).toBe('s')
  })
})

describe('AppError', () => {
  test('toJSON 无 data 时不含 data 键', () => {
    const json = new AppError('kernel.internal', 'x').toJSON()
    expect('data' in json).toBe(false)
    expect(json).toEqual({ code: 'kernel.internal', message: 'x' })
  })

  test('toJSON 的结果能被 SerializedAppError 解析', () => {
    const error = new AppError('kernel.internal', 'x', { a: 1 })
    expect(SerializedAppError.parse(error.toJSON())).toEqual({ code: 'kernel.internal', message: 'x', data: { a: 1 } })
  })

  test('isAppError 区分 AppError 与普通 Error', () => {
    expect(isAppError(new AppError('kernel.internal', 'x'))).toBe(true)
    expect(isAppError(new Error('x'))).toBe(false)
  })
})
