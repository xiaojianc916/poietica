import type { ReactNode } from 'react'

type WorkspacePartId = 'chrome' | 'sidebar' | 'main' | 'auxiliary'

export interface WorkspacePart {
  readonly content: ReactNode

  readonly label?: string | undefined
}

/** 主区内容由组合根提供；控件由外壳摆放，以保持跨布局状态的 DOM 身份。 */
export interface WorkspaceMainPart extends WorkspacePart {
  readonly controls: ReactNode
}

export interface WorkspaceAuxiliaryPart extends WorkspacePart {
  readonly isDocked: boolean
}

export type WorkspaceParts = Record<
  Exclude<WorkspacePartId, 'main' | 'auxiliary'>,
  WorkspacePart
> & {
  readonly main: WorkspaceMainPart
  readonly auxiliary: WorkspaceAuxiliaryPart
}
