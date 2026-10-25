import { platformContract } from '@poietica/feature-platform/contract'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import { exportFileNameOf, type IntelligentUiState, intelligentUiContract } from '../contract'

export interface ExportRequest {
  readonly title: string
  readonly html: string
  readonly bare: boolean
  readonly wide: boolean
  readonly css: string
  readonly theme: 'dark' | 'light'
  readonly state: IntelligentUiState
}

/** 本功能的 RPC 入口；导出先经 platform 选路径，取消时不调用 Host 写文件。 */
export function createIntelligentUiApi(ctx: UiFeatureContext) {
  const platform = ctx.rpc(platformContract)
  const rpc = ctx.rpc(intelligentUiContract)

  return {
    loadState: async (threadId: string, callId: string): Promise<IntelligentUiState | null> =>
      (await rpc.call('intelligentUi.getState', { threadId, callId })).state,
    saveState: async (threadId: string, callId: string, title: string, state: IntelligentUiState): Promise<void> => {
      await rpc.call('intelligentUi.setState', { threadId, callId, title, ...state })
    },
    copyImage: async (rect: { x: number; y: number; width: number; height: number }): Promise<void> => {
      await rpc.call('intelligentUi.copyImage', { rect })
    },
    exportHtml: async (request: ExportRequest): Promise<string | null> => {
      const { path } = await platform.call('dialog.pickSavePath', {
        defaultName: exportFileNameOf(request.title),
        filters: [{ name: 'HTML', extensions: ['html'] }],
      })
      if (path === null) return null
      return (await rpc.call('intelligentUi.exportHtml', { ...request, path })).path
    },
    openExternal: (url: string): Promise<void> => platform.call('shell.openExternal', { url }).then(() => undefined),
    showInFolder: (path: string): Promise<void> => platform.call('shell.showInFolder', { path }).then(() => undefined),
  }
}

export type IntelligentUiApi = ReturnType<typeof createIntelligentUiApi>
