import { describe, expect, test } from 'bun:test'
import type { Contract } from '@poietica/contract-kit'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import { createIntelligentUiApi, type ExportRequest } from '../api'

const request: ExportRequest = {
  title: '方案 A/B',
  html: '<p>正文</p>',
  bare: false,
  wide: false,
  css: ':root{}',
  theme: 'dark',
  state: { model: null, view: null, tweaks: null },
}

interface Call {
  readonly namespace: string
  readonly method: string
  readonly params: unknown
}

function apiWith(answer: (method: string, params: unknown) => unknown): {
  readonly api: ReturnType<typeof createIntelligentUiApi>
  readonly calls: Call[]
} {
  const calls: Call[] = []
  const ctx = {
    rpc(contract: Contract) {
      return {
        call(method: string, params: unknown) {
          calls.push({ namespace: contract.id, method, params })
          return Promise.resolve(answer(method, params))
        },
      }
    },
  } as unknown as UiFeatureContext
  return { api: createIntelligentUiApi(ctx), calls }
}

function exportAnswer(path: string | null) {
  return (method: string, params: unknown): unknown => {
    if (method === 'dialog.pickSavePath') return { path }
    if (method === 'intelligentUi.exportHtml') {
      const input = params as { path: string }
      return { path: input.path }
    }
    throw new Error(`意外调用：${method}`)
  }
}

describe('导出 HTML 的 RPC 编排', () => {
  test('用 platform 选择路径，Host 收到同一路径和完整 HTML 参数', async () => {
    const { api, calls } = apiWith(exportAnswer('D:/导出/方案.html'))

    await expect(api.exportHtml(request)).resolves.toBe('D:/导出/方案.html')
    expect(calls).toEqual([
      {
        namespace: 'platform',
        method: 'dialog.pickSavePath',
        params: { defaultName: '方案 A B.html', filters: [{ name: 'HTML', extensions: ['html'] }] },
      },
      {
        namespace: 'intelligent-ui',
        method: 'intelligentUi.exportHtml',
        params: { ...request, path: 'D:/导出/方案.html' },
      },
    ])
  })

  test('取消保存返回 null，不调用 Host 写文件', async () => {
    const { api, calls } = apiWith(exportAnswer(null))

    await expect(api.exportHtml(request)).resolves.toBeNull()
    expect(calls.map((call) => call.method)).toEqual(['dialog.pickSavePath'])
  })

  test('选择路径与写文件的失败都原样透传', async () => {
    const pickFailure = new Error('对话框失败')
    const picking = apiWith(() => {
      throw pickFailure
    })
    await expect(picking.api.exportHtml(request)).rejects.toBe(pickFailure)
    expect(picking.calls.map((call) => call.method)).toEqual(['dialog.pickSavePath'])

    const writeFailure = new Error('写文件失败')
    const writing = apiWith((method) => {
      if (method === 'dialog.pickSavePath') return { path: 'D:/导出/方案.html' }
      throw writeFailure
    })
    await expect(writing.api.exportHtml(request)).rejects.toBe(writeFailure)
  })
})
