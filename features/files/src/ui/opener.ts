import type { WorkspacesUi } from '@poietica/feature-workspaces/ui-api'
import type { Logger } from '@poietica/foundation'
import type { BannerService, LayoutService } from '@poietica/ui-kernel'
import type { FilesApi } from './api'
import type { FileTabsStore } from './tabs'

/** 右坞两格的 id：树（pane，进启动器）与查看器（标签组，只能由代码打开）。 */
export const TREE_PANEL_ID = 'files.tree'
export const VIEWER_PANEL_ID = 'files.viewer'

export interface FileOpenRequest {
  readonly path: string
  readonly line?: number | null
  readonly column?: number | null
  /** 不给就是当前前台（坞此刻的归属）。 */
  readonly owner?: string | null
  /** 不给就是当前工作区。 */
  readonly workspaceId?: string | null
}

export interface FileOpener {
  /** 树里点的：路径已是工作区内的相对路径，直接开。 */
  openListed(owner: string, workspaceId: string, path: string): void
  /** 正文里写的：先让 Core 解析（相对 / 绝对、是否在工作区内、是文件还是目录），再开或在树里定位。 */
  openReference(request: FileOpenRequest): void
}

export function createFileOpener(d: {
  readonly api: Pick<FilesApi, 'locate'>
  readonly tabs: FileTabsStore
  readonly layout: LayoutService
  readonly workspaces: Pick<WorkspacesUi, 'store'>
  readonly banners: Pick<BannerService, 'show' | 'error'>
  /** 横幅只说一句人话，具体原因落这里。 */
  readonly logger: Logger
  /** 目录：打开树并展开到它。 */
  readonly revealInTree: (owner: string, workspaceId: string, path: string) => void
}): FileOpener {
  const show = (owner: string, workspaceId: string, path: string, line: number | null, column: number | null): void => {
    d.tabs.open(owner, workspaceId, path, line, column)
    d.layout.focusPane(owner, VIEWER_PANEL_ID)
    d.layout.setDockOpen(owner, true)
  }

  return {
    openListed(owner, workspaceId, path) {
      show(owner, workspaceId, path, null, null)
    },
    openReference(request) {
      const owner = request.owner ?? d.layout.current().auxiliary.activeOwner
      const workspaceId = request.workspaceId ?? d.workspaces.store.getState().activeId
      if (owner === null || workspaceId === null) {
        d.banners.show({ severity: 'info', title: '这里打不开文件', detail: '先打开一个有工作区的对话。' })
        return
      }
      d.api.locate(workspaceId, request.path).then(
        (located) => {
          if (located.kind === 'directory') d.revealInTree(owner, workspaceId, located.path)
          else show(owner, workspaceId, located.path, request.line ?? null, request.column ?? null)
        },
        (cause: unknown) => {
          /* 打不开就一句话：**文件不存在**。不叠「打不开这个文件：」这层前缀，也不带路径 ——
           * 横幅上原先是「打不开这个文件：文件不存在：文件不存在：path.txt」（标题、契约文案、服务端
           * message 各拼了一遍），读起来像三种错。具体原因（越界、权限、认不出的异常）落日志。 */
          d.logger.warn('打开文件失败', { error: String(cause), path: request.path })
          d.banners.show({ severity: 'error', title: '文件不存在' })
        },
      )
    },
  }
}
