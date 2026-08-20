import type { KapToolCallId } from './kap'

/** 产品的工具类别：kap 的 display.kind 一档一映（packages/agent 的 kap-projection.ts）。 */
export type ToolKind =
  | 'delegate'
  | 'edit'
  | 'execute'
  | 'fetch'
  | 'goal'
  | 'other'
  | 'plan'
  | 'read'
  | 'search'
  | 'skill'
  | 'task'
  | 'todo'
  | 'write'

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
  /**
   * 一条要执行的命令，带它自己的语言标注。
   *
   * kap 的 command 档自带 language（display.ts 的 CommandDisplay），上游自己的客户端
   * 就是这么画的：apps/vscode 的 toLegacyDisplay 落 { type: 'shell', language:
   * display.language ?? 'bash', command }。印成一块 JSON 是把一条给人读的命令压成
   * 一行带转义的字符串。
   */
  | { readonly type: 'command'; readonly command: string; readonly language: string }
  /**
   * 一段 markdown 散文：计划正文。
   *
   * 与 text 那一档的分别是它不该被包进围栏 —— 围栏对程序产出是对的（stdout 不是
   * markdown），对一份计划是错的：标题与列表会连符号一起印出来。
   */
  | { readonly type: 'prose'; readonly text: string }
  /**
   * 一张任务清单。
   *
   * 结构化而不是一段拼好的 markdown：这一层是产品模型，画成勾选表还是画成三栏
   * 归表现层。三档状态照上游的词汇留（todo_list.items[].status），归一化判据与
   * apps/vscode 的 toLegacyDisplay 相同：只认 'done' 与 'in_progress'。
   */
  | {
      readonly type: 'todo'
      readonly items: readonly {
        readonly title: string
        readonly status: 'done' | 'in_progress' | 'pending'
      }[]
    }

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
