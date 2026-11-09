// omp 工具载荷的类型：入参按工具名各有其形，产出统一是 `{ content, details }`。
// 界面按名字取到各自的处理器，处理器里直接读字段；认不出的名字只有 generic 那一档。
//
// 只有 omp 公开导出的类型才从包里取（`.../tools/<tool>`）；没有导出输入类型的工具，这里按
// 「卡片实际读的那几个字段」写最小结构接口 —— 不照抄 omp 内部 schema，免得跟着它的实现漂移。

import type { AskToolInput } from '@oh-my-pi/pi-coding-agent/tools/ask'
import type { BashToolInput } from '@oh-my-pi/pi-coding-agent/tools/bash'
import type { GlobToolInput } from '@oh-my-pi/pi-coding-agent/tools/glob'
import type { GrepToolInput } from '@oh-my-pi/pi-coding-agent/tools/grep'
import type { FindToolInput } from '@oh-my-pi/pi-coding-agent/tools/jfind'
import type { ReadToolInput } from '@oh-my-pi/pi-coding-agent/tools/read'
import type { WriteToolInput } from '@oh-my-pi/pi-coding-agent/tools/write'
import type { AskToolDetails } from '@oh-my-pi/pi-tui/tools/ask'
import type { AstEditToolDetails } from '@oh-my-pi/pi-tui/tools/ast-edit'
import type { AstGrepToolDetails } from '@oh-my-pi/pi-tui/tools/ast-grep'
import type { BashToolDetails } from '@oh-my-pi/pi-tui/tools/bash'
import type { DebugToolDetails } from '@oh-my-pi/pi-tui/tools/debug'
import type { EditToolDetails } from '@oh-my-pi/pi-tui/tools/edit'
import type { EvalCellResult, EvalStatusEvent, EvalToolDetails } from '@oh-my-pi/pi-tui/tools/eval'
import type { ReadUrlToolDetails } from '@oh-my-pi/pi-tui/tools/fetch'
import type { FindToolDetails } from '@oh-my-pi/pi-tui/tools/find'
import type { GhToolDetails } from '@oh-my-pi/pi-tui/tools/github'
import type { GlobToolDetails } from '@oh-my-pi/pi-tui/tools/glob'
import type { GoalToolDetails } from '@oh-my-pi/pi-tui/tools/goal'
import type { GrepToolDetails } from '@oh-my-pi/pi-tui/tools/grep'
import type { LspToolDetails } from '@oh-my-pi/pi-tui/tools/lsp'
import type { MCPToolDetails } from '@oh-my-pi/pi-tui/tools/mcp'
import type { OutputMeta } from '@oh-my-pi/pi-tui/tools/output-meta'
import type { ReadToolDetails } from '@oh-my-pi/pi-tui/tools/read'
import type { TaskToolDetails } from '@oh-my-pi/pi-tui/tools/task'
import type { TodoItem, TodoPhase, TodoToolDetails } from '@oh-my-pi/pi-tui/tools/todo'
import type { VibeToolDetails } from '@oh-my-pi/pi-tui/tools/vibe'
import type { WriteToolDetails } from '@oh-my-pi/pi-tui/tools/write'

/** 一次工具调用产出的正文块：omp 的 `content` 数组，文字与图片之外的类型不解释。 */
export interface OmpToolContentBlock {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

/** 后台作业标记：任何工具都可能被自动转成后台作业，卡片只读「是不是」这一件事。 */
export interface OmpToolAsyncJob {
  readonly state: string
  readonly jobId: string
  readonly type?: string
}

/** 所有工具产出 details 共有的两格。 */
export interface OmpToolDetailBase {
  readonly meta?: OutputMeta
  readonly async?: OmpToolAsyncJob
}

/* ==== 没有公开导出输入类型的工具：卡片实际读的字段 ==== */

/** `edit` 与 `apply_patch`：hashline 与补丁两种入参，卡片读的是同一组字段。 */
export interface OmpEditToolInput {
  readonly path?: string
  readonly oldText?: string
  readonly newText?: string
  readonly old_string?: string
  readonly new_string?: string
  /** 补丁模式下整段补丁正文。 */
  readonly input?: string
}

/** 浏览器卡片直接读的 eval 细节：cells / statusEvents / images 都是 omp 的公开形状。 */
export type OmpEvalDetails = EvalToolDetails
export type OmpEvalCellResult = EvalCellResult
export type OmpEvalStatusEvent = EvalStatusEvent

/** `eval` 与 `js` / `python` / `notebook` 别名：一次调用一个 cell。 */
export interface OmpEvalToolInput {
  readonly language?: string
  readonly code?: string
  readonly title?: string
  readonly cells?: readonly { readonly code?: string }[]
}

/** `read` 的 URL 分支与旧 `fetch` 工具。 */
export interface OmpFetchToolInput {
  readonly url?: string
  readonly path?: string
}

/** eval 注入的 prelude 作用域：browser / computer 不是顶层工具，入参形状由 prelude 定。 */
export interface OmpBrowserToolInput {
  readonly action?: string
  readonly name?: string
  readonly url?: string
  readonly code?: string
  readonly fn?: string
  readonly chain?: unknown
}

export interface OmpComputerToolInput {
  readonly action?: string
  readonly code?: string
  readonly fn?: string
  readonly chain?: unknown
}

export interface OmpAstEditToolInput {
  readonly paths?: readonly string[]
  readonly ops?: readonly { readonly pat?: string }[]
}

export interface OmpAstGrepToolInput {
  readonly pat?: string
  readonly path?: string
}

export interface OmpLspToolInput {
  readonly action?: string
  readonly file?: string
  readonly symbol?: string
  readonly query?: string
}

export interface OmpTodoToolInput {
  readonly op?: string
  readonly task?: string
  readonly phase?: string
  readonly items?: readonly string[]
  /** init 的分段清单：每段一组任务。 */
  readonly list?: readonly { readonly phase?: string; readonly items?: readonly string[] }[]
}

export interface OmpTaskToolInput {
  readonly task?: string
  readonly name?: string
  readonly agent?: string
  readonly context?: string
  readonly tasks?: readonly { readonly name?: string; readonly task?: string; readonly description?: string }[]
}

export interface OmpYieldingToolInput {
  readonly type?: string | readonly string[]
  readonly error?: string
  readonly data?: unknown
}

export interface OmpThinkToolInput {
  readonly thoughts?: string
}

export interface OmpGoalToolInput {
  readonly op?: string
  readonly objective?: string
  readonly token_budget?: number
}

export interface OmpCheckpointToolInput {
  readonly goal?: string
}

export interface OmpRewindToolInput {
  readonly report?: string
}

export interface OmpContextNotesToolInput {
  readonly text?: string
}

export interface OmpHubToolInput {
  readonly op?: string
  readonly to?: string
  readonly name?: string
  readonly from?: string
  readonly application?: string
}

export interface OmpWebSearchToolInput {
  readonly query?: string
  readonly recency?: string
}

export interface OmpGithubToolInput {
  readonly op?: string
  readonly repo?: string
  readonly path?: string
  readonly pr?: string | readonly string[]
  readonly branch?: string
  readonly query?: string
  readonly title?: string
  readonly run?: string
}

export interface OmpDebugToolInput {
  readonly action?: string
  readonly program?: string
  readonly file?: string
  readonly function?: string
  readonly name?: string
  readonly expression?: string
}

export interface OmpSecurityScanToolInput {
  readonly action?: string
  readonly target_kind?: string
  readonly plan_id?: string
  readonly scan_id?: string
}

export interface OmpMemoryEditToolInput {
  readonly op?: string
  readonly id?: string
}

export interface OmpIdaToolInput {
  readonly action?: string
  readonly db?: string
  readonly target?: string
}

export interface OmpRetainToolInput {
  readonly items?: readonly { readonly content?: string }[]
}

export interface OmpRecallToolInput {
  readonly query?: string
}

export interface OmpLearnToolInput {
  readonly memory?: string
  readonly skill?: { readonly name?: string; readonly action?: string }
}

export interface OmpManageSkillToolInput {
  readonly action?: string
  readonly name?: string
  readonly description?: string
  readonly body?: string
}

export interface OmpImageGenToolInput {
  readonly subject?: string
  readonly changes?: string | readonly string[]
}

export interface OmpTtsToolInput {
  readonly text?: string
  readonly output_path?: string
}

export interface OmpVibeSpawnToolInput {
  readonly cli?: string
  readonly prompt?: string
}

export interface OmpVibeSendToolInput {
  readonly session?: string
  readonly message?: string
}

export interface OmpVibeSessionToolInput {
  readonly session?: string
}

export interface OmpVibeWaitToolInput {
  readonly sessions?: readonly string[]
}

/** 没有入参（或卡片不读入参）的工具。 */
export type OmpNoToolInput = Readonly<Record<string, never>>

/** MCP 工具的产出细节：`mcp__*` 的服务器名与原始工具名从这一对里取。 */
export type OmpMcpToolDetails = MCPToolDetails & OmpToolDetailBase

/** 任务清单里的一格与一段：omp 的 TodoItem / TodoPhase，卡片自己拼 GFM 清单。 */
export type OmpTodoItem = TodoItem
export type OmpTodoPhase = TodoPhase

/* ==== 没有公开导出 details 类型、卡片又不读细节的工具 ==== */

/** 卡片不读细节：产出正文与状态已经说完了这件事。 */
export type OmpOpaqueToolDetails = Readonly<Record<string, unknown>>

/** browser / computer prelude 的产出：卡片只读被打开的地址与截了几张图。 */
export interface OmpPreludeToolDetails {
  readonly url?: string
  readonly screenshots?: readonly unknown[]
}

/** web_search 的产出细节：卡片只数来源条数。 */
export interface OmpWebSearchToolDetails {
  readonly response?: { readonly sources?: readonly unknown[] }
}

/** 工具名 → 入参形状。表里的名字都是 omp 真的会报出来的（含官方视图表登记的历史别名）。 */
export interface OmpToolInputs {
  readonly apply_patch: OmpEditToolInput
  readonly ask: AskToolInput
  readonly ast_edit: OmpAstEditToolInput
  readonly ast_grep: OmpAstGrepToolInput
  readonly bash: BashToolInput
  readonly browser: OmpBrowserToolInput
  readonly checkpoint: OmpCheckpointToolInput
  readonly computer: OmpComputerToolInput
  readonly context_notes: OmpContextNotesToolInput
  readonly debug: OmpDebugToolInput
  readonly edit: OmpEditToolInput
  readonly eval: OmpEvalToolInput
  readonly fetch: OmpFetchToolInput
  readonly find: FindToolInput
  readonly generate_image: OmpImageGenToolInput
  readonly github: OmpGithubToolInput
  readonly glob: GlobToolInput
  readonly goal: OmpGoalToolInput
  readonly grep: GrepToolInput
  readonly hub: OmpHubToolInput
  readonly ida: OmpIdaToolInput
  readonly intelligent_ui_guide: OmpNoToolInput
  readonly js: OmpEvalToolInput
  readonly learn: OmpLearnToolInput
  readonly lsp: OmpLspToolInput
  readonly manage_skill: OmpManageSkillToolInput
  readonly memory_edit: OmpMemoryEditToolInput
  readonly new_context: OmpNoToolInput
  readonly notebook: OmpEvalToolInput
  readonly propose: OmpNoToolInput
  readonly puppeteer: OmpBrowserToolInput
  readonly python: OmpEvalToolInput
  readonly read: ReadToolInput
  readonly recall: OmpRecallToolInput
  readonly reflect: OmpRecallToolInput
  readonly reject: OmpNoToolInput
  readonly report_issue: OmpNoToolInput
  readonly report_tool_issue: OmpNoToolInput
  readonly resolve: OmpNoToolInput
  readonly retain: OmpRetainToolInput
  readonly rewind: OmpRewindToolInput
  readonly search: GrepToolInput
  readonly security_scan: OmpSecurityScanToolInput
  readonly task: OmpTaskToolInput
  readonly think: OmpThinkToolInput
  readonly todo: OmpTodoToolInput
  readonly tts: OmpTtsToolInput
  readonly vibe_kill: OmpVibeSessionToolInput
  readonly vibe_list: OmpNoToolInput
  readonly vibe_send: OmpVibeSendToolInput
  readonly vibe_spawn: OmpVibeSpawnToolInput
  readonly vibe_wait: OmpVibeWaitToolInput
  readonly wait: OmpNoToolInput
  readonly web_search: OmpWebSearchToolInput
  readonly write: WriteToolInput
  readonly yield: OmpYieldingToolInput
}

/** 工具名 → 产出 details 的形状（与 {@link OmpToolDetailBase} 相交后才是完整那一份）。 */
export interface OmpToolDetailFields {
  readonly apply_patch: EditToolDetails
  readonly ask: AskToolDetails
  readonly ast_edit: AstEditToolDetails
  readonly ast_grep: AstGrepToolDetails
  readonly bash: BashToolDetails
  readonly browser: OmpPreludeToolDetails
  readonly checkpoint: OmpOpaqueToolDetails
  readonly computer: OmpPreludeToolDetails
  readonly context_notes: OmpOpaqueToolDetails
  readonly debug: DebugToolDetails
  readonly edit: EditToolDetails
  readonly eval: EvalToolDetails
  readonly fetch: ReadUrlToolDetails
  readonly find: FindToolDetails
  readonly generate_image: OmpOpaqueToolDetails
  readonly github: GhToolDetails
  readonly glob: GlobToolDetails
  readonly goal: GoalToolDetails
  readonly grep: GrepToolDetails
  readonly hub: OmpOpaqueToolDetails
  readonly ida: OmpOpaqueToolDetails
  readonly intelligent_ui_guide: OmpOpaqueToolDetails
  readonly js: EvalToolDetails
  readonly learn: OmpOpaqueToolDetails
  readonly lsp: LspToolDetails
  readonly manage_skill: OmpOpaqueToolDetails
  readonly memory_edit: OmpOpaqueToolDetails
  readonly new_context: OmpOpaqueToolDetails
  readonly notebook: EvalToolDetails
  readonly propose: OmpOpaqueToolDetails
  readonly puppeteer: OmpPreludeToolDetails
  readonly python: EvalToolDetails
  readonly read: ReadToolDetails
  readonly recall: OmpOpaqueToolDetails
  readonly reflect: OmpOpaqueToolDetails
  readonly reject: OmpOpaqueToolDetails
  readonly report_issue: OmpOpaqueToolDetails
  readonly report_tool_issue: OmpOpaqueToolDetails
  readonly resolve: OmpOpaqueToolDetails
  readonly retain: OmpOpaqueToolDetails
  readonly rewind: OmpOpaqueToolDetails
  readonly search: GrepToolDetails
  readonly security_scan: OmpOpaqueToolDetails
  readonly task: TaskToolDetails
  readonly think: OmpOpaqueToolDetails
  readonly todo: TodoToolDetails
  readonly tts: OmpOpaqueToolDetails
  readonly vibe_kill: VibeToolDetails
  readonly vibe_list: VibeToolDetails
  readonly vibe_send: VibeToolDetails
  readonly vibe_spawn: VibeToolDetails
  readonly vibe_wait: VibeToolDetails
  readonly wait: OmpOpaqueToolDetails
  readonly web_search: OmpWebSearchToolDetails
  readonly write: WriteToolDetails
  readonly yield: OmpOpaqueToolDetails
}

/** 界面认识的工具名。 */
export type OmpToolName = keyof OmpToolInputs

export type OmpToolInput<N extends OmpToolName> = OmpToolInputs[N]
export type OmpToolDetails<N extends OmpToolName> = OmpToolDetailFields[N] & OmpToolDetailBase

/** omp 的一次工具产出。 */
export interface OmpToolOutput<N extends OmpToolName> {
  readonly content?: readonly OmpToolContentBlock[]
  readonly details?: OmpToolDetails<N>
}

/* ==== generic 兜底：mcp__* 与认不出的名字 ==== */

export interface OmpGenericToolInput {
  readonly [key: string]: unknown
}

export interface OmpGenericToolDetails extends OmpToolDetailBase {
  readonly [key: string]: unknown
}

export interface OmpGenericToolOutput {
  readonly content?: readonly OmpToolContentBlock[]
  readonly details?: OmpGenericToolDetails
}

/**
 * 帧与卡片之间搬来搬去的载荷：认识的名字给精确形状，其余只保证是对象。
 * 这是**边界**的类型 —— 运行时形状由 omp 的 tool schema 保证，这里不再二次校验。
 */
export type OmpToolInputOf = OmpToolInput<OmpToolName> | OmpGenericToolInput

/**
 * 产出的边界类型。`string` 是老会话与流式覆盖里遗留的纯文本产出（那时还没有 content 块）。
 */
export type OmpToolOutputOf = OmpToolOutput<OmpToolName> | OmpGenericToolOutput | string

export type OmpToolDetailsOf = OmpToolDetails<OmpToolName> | OmpGenericToolDetails | OmpMcpToolDetails | undefined
