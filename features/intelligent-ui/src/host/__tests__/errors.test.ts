import { describe, expect, test } from 'bun:test'
import { intelligentUiErrors } from '../../contract'
import { clipboardFailureOf } from '../capture'

/*
 * Host 的 handler 直接依赖 electron，单测不加载整个模块；这里钉住它能独立验证的两端：
 * 契约里的错误码/默认文案，以及剪贴板失败的纯映射（handler 只负责 log + throw）。
 */
describe('Host 业务错误', () => {
  test('H1 契约有 export_failed；默认文案是用户能看懂的中文', () => {
    expect(intelligentUiErrors.export_failed).toBe('intelligent-ui.export_failed')
    expect(intelligentUiErrors.__messages[intelligentUiErrors.export_failed]).toBe('没能导出界面文件')
    expect(intelligentUiErrors.capture_failed).toBe('intelligent-ui.capture_failed')
  })

  test('H2 剪贴板写入失败：稳定错误码 + 可读文案 + 原始 cause', () => {
    const error = clipboardFailureOf(new Error('The clipboard is busy'))
    expect(error.code).toBe(intelligentUiErrors.capture_failed)
    expect(error.message).toBe('没能把图片写进剪贴板')
    expect(error.data).toEqual({ cause: 'The clipboard is busy' })
    expect(clipboardFailureOf('unknown failure').data).toEqual({ cause: 'unknown failure' })
  })
})
