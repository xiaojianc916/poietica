import { defineContributionPoint } from '@poietica/ui-kernel'
import type { ComponentType, ReactNode } from 'react'

/** 入口页选择器里还没落账的一笔：模型 / 档位。 */
export interface DraftSelection {
  readonly model?: import('@poietica/runtime-protocol').ModelRef | null | undefined
  readonly thinking?: string | null | undefined
  readonly posture?: import('@poietica/runtime-protocol').Posture | undefined
  readonly plan?: boolean | undefined
  readonly goal?: boolean | undefined
}

/** 草稿引用的只读视图；attachments 的 trackDraftRefs 按结构接收。 */
export interface DraftRefSource {
  ids(): readonly string[] | null
  subscribe(listener: () => void): () => void
  drop(ids: readonly string[]): number
}

export interface DraftAttachment {
  readonly id: string
  readonly name: string
  readonly kind: 'image' | 'file'
  readonly previewUrl: string | null
}

export interface ComposerDraft {
  readonly threadId: string | null
  addAttachments(items: readonly DraftAttachment[]): void
  insertText(text: string): void
  submit(): void
}

export interface ComposerAction {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<{ draft: ComposerDraft }>
}
export const composerActions = defineContributionPoint<ComposerAction>('composer.actions')

export interface ComposerInputHandler {
  readonly id: string
  claims?(event: ClipboardEvent): boolean
  onPaste?(event: ClipboardEvent, draft: ComposerDraft): boolean | Promise<boolean>
  onDrop?(event: DragEvent, draft: ComposerDraft): boolean | Promise<boolean>
}
export const composerInputHandlers = defineContributionPoint<ComposerInputHandler>('composer.inputHandlers')

export interface ComposerContextItem {
  readonly id: string
  readonly order: number
  readonly component: ComponentType
}
export const composerContextItems = defineContributionPoint<ComposerContextItem>('composer.contextItems')

export interface ComposerProviderItem {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<{ readonly children: ReactNode }>
}
export const composerProviders = defineContributionPoint<ComposerProviderItem>('composer.providers')

export interface ToolkitSkill {
  readonly name: string
  readonly description: string
  readonly source: 'user' | 'project'
}
export interface ToolkitMcpServer {
  readonly name: string
  readonly state: 'connecting' | 'connected' | 'disconnected' | 'failed'
  readonly toolCount: number
  readonly error: string | null
}
export interface ComposerToolkit {
  readonly skills: readonly ToolkitSkill[]
  readonly mcpServers: readonly ToolkitMcpServer[]
}
export const EMPTY_TOOLKIT: ComposerToolkit = Object.freeze({ skills: [], mcpServers: [] })
export interface ComposerToolkitSource {
  readonly id: string
  ensure(workspaceId: string | null): void
  read(workspaceId: string | null): ComposerToolkit
  subscribe(listener: () => void): () => void
}
export const composerToolkitSources = defineContributionPoint<ComposerToolkitSource>('composer.toolkitSources')
