export type ToolKind =
  | 'delegate'
  | 'edit'
  | 'execute'
  | 'fetch'
  | 'goal'
  | 'other'
  | 'read'
  | 'search'
  | 'skill'
  | 'todo'
  | 'write'

// flow: 送出在上、交回在下同一张纸；diff: 一处改动按行画；
// result: 只有产出面；tabs: 两头不相干时退到入参/产出两页签。
export type ToolDrawerShape = 'diff' | 'flow' | 'result' | 'tabs'

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
  | { readonly type: 'command'; readonly command: string; readonly language: string }
  | { readonly type: 'prose'; readonly text: string }
  | {
      readonly type: 'todo'
      readonly items: readonly {
        readonly title: string
        readonly status: 'done' | 'in_progress' | 'pending'
      }[]
    }
