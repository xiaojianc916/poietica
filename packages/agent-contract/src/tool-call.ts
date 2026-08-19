import type { KapToolCallId } from './kap'

export type ToolKind = 'edit' | 'execute' | 'fetch' | 'other' | 'read' | 'search'

export type ToolCallStatus = 'completed' | 'failed' | 'in_progress' | 'pending'

export interface ToolCallLocation {
  readonly path: string
}

export type ToolCallContent =
  | { readonly type: 'content'; readonly content: { readonly type: 'text'; readonly text: string } }
  | {
      readonly type: 'content'
      readonly content: { readonly type: 'image'; readonly data: string; readonly mimeType: string }
    }
  | {
      readonly type: 'content'
      readonly content: { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
    }
  | {
      readonly type: 'diff'
      readonly path: string
      readonly oldText?: string | undefined
      readonly newText: string
    }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name?: string | undefined }
  | {
      readonly type: 'resource'
      readonly resource: {
        readonly uri: string
        readonly text?: string | undefined
        readonly blob?: string | undefined
        readonly mimeType?: string | undefined
      }
    }
  | { readonly type: 'terminal'; readonly terminalId: string }

export interface ToolCallUpdate {
  readonly toolCallId: KapToolCallId
  readonly title?: string | undefined
  readonly kind?: ToolKind | undefined
  readonly status?: ToolCallStatus | undefined
  readonly content?: readonly ToolCallContent[] | undefined
  readonly locations?: readonly ToolCallLocation[] | undefined
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}
