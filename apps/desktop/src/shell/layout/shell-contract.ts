import type { SurfaceId, WorkbenchTabId } from '@poietica/workspace'
import type { ReactNode } from 'react'

type WorkspacePartId = 'chrome' | 'sidebar' | 'main' | 'auxiliary'

export interface WorkspacePart {
  readonly content: ReactNode

  readonly label?: string | undefined
}

/** 主区内容由组合根提供；控件由外壳摆放，以保持跨布局状态的 DOM 身份。 */
interface WorkspaceMainPart extends WorkspacePart {
  readonly controls: ReactNode
}

interface WorkspaceAuxiliaryPart extends WorkspacePart {
  readonly isDocked: boolean
  /**
   * 收起这一列时做什么。省略就是「不再属于任何对话」。
   *
   * 显式带上 undefined：exactOptionalPropertyTypes 下「?: () => void」不接受一个显式
   * 传进来的 undefined，而组合根按当前布局决定给不给它，正是那种转发。
   */
  readonly onClose?: (() => void) | undefined
}

export type WorkspaceParts = Record<
  Exclude<WorkspacePartId, 'main' | 'auxiliary'>,
  WorkspacePart
> & {
  readonly main: WorkspaceMainPart
  readonly auxiliary: WorkspaceAuxiliaryPart
}

/** 外壳转交给顶栏的动作。只列实际被消费的：空着的成员是没人兑现的承诺。 */
export interface WorkspaceShellActions {
  readonly activateTab: (tabId: WorkbenchTabId) => void
  /** 只收 id，标题由 registry 查。 */
  readonly openSurface: (surfaceId: SurfaceId) => void
}

export interface WorkspaceShellProps {
  readonly parts: WorkspaceParts
}
