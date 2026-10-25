import { defineServiceToken } from '@poietica/foundation'
import { defineContributionPoint, type IconComponent, type SurfaceComponent } from '@poietica/ui-kernel'
import type { ComponentType, ReactNode } from 'react'
import type { Thread } from '../contract'

/*
 * 分支选择器本体（GitBranchPicker）住在 design-system：它只认 props、不认识 git 也不调 RPC，
 * review（输入框那枚 chip）与 conversation（状态面板那一行）各自从 `@poietica/design-system` 取。
 */

/*
 * 状态面板「Git 工具」那一格的事实与投递口（见 ./git-status.ts 的头注）。
 *
 * 它与上面那枚分支 chip 同一份数据、同一个来源功能：**分支与改动数是同一次读到的**，
 * 所以两者要么一起新、要么一起旧，不会出现「分支切了、数字还是上一个分支的」。
 */
export {
  useWorkspaceGitFacts,
  type WorkspaceGitFacts,
  type WorkspaceGitProviderItem,
  type WorkspaceGitStatus,
  workspaceGitContext,
  workspaceGitProviders,
} from './git-status'
/*
 * 每轮回复下方那条「N 个文件已更改 / 撤销」的数据落点（见 ./turn-changes.ts 的头注）。
 *
 * 与上面那一格同一形制、同一条理由：账本属于 review，conversation 只画。
 */
export {
  type TurnChangesApi,
  type TurnChangesFile,
  type TurnChangesProviderItem,
  type TurnChangesView,
  type TurnDiffOpener,
  type TurnDiffRequest,
  turnChangesContext,
  turnChangesProviders,
  turnDiffOpeners,
  useTurnChanges,
  useTurnChangesOf,
  useTurnDiffOpener,
} from './turn-changes'
/**
 * 输入框下方那一行的其它 chip。
 *
 * 工作区胶囊由 conversation 自己画（它认识工作区），分支胶囊由 review 贡献：
 * conversation 不认识 git，review 也不该认识输入框的排版。
 */
export interface ComposerContextItem {
  readonly id: string
  readonly order: number
  readonly component: ComponentType
}
export const composerContextItems = defineContributionPoint<ComposerContextItem>('conversation.composerContextItems')

/**
 * 输入框树的外层提供者：别的功能往输入框树里放一层 Context 的插槽。
 *
 * 附件的入库口不走这里的外部贡献：conversation 依赖 attachments（功能分级里 attachments 在下），
 * 由 ui/setup/attachments.tsx 用 `AttachmentsUiToken` 拼好入库口，自己往这个插槽里放。
 */
export interface ComposerProviderItem {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<{ readonly children: ReactNode }>
}
export const composerProviders = defineContributionPoint<ComposerProviderItem>('conversation.composerProviders')

/*
 * 加号面板里「技能 / MCP」两组的数据落点（见 ./composer-toolkit.ts 的头注）。
 *
 * 名册属于 extensions（它持有 `skills.list` / `mcp.status` / `mcp.statusChanged`），
 * conversation 只画面板，所以 conversation 留贡献点、extensions 提供数据 ——
 * 与上面的 composerProviders 同一形制。
 */
export {
  type ComposerToolkit,
  type ComposerToolkitSource,
  composerToolkitSources,
  EMPTY_TOOLKIT,
  type ToolkitMcpServer,
  type ToolkitSkill,
} from './composer-toolkit'

/**
 * 输入框斜杠命令面板里由别的功能提供的命令：MCP、技能、用量、记忆…… 这些能力住在别的功能里，命令只是「打开那一页」的快捷方式，
 * conversation 不认识那些页。与 omp 的内置命令同名时以这里为准（`/mcp` 在 GUI 里就是打开 MCP 设置页，不是终端里的子命令）。
 * 任何场所都列（入口页也能用）：打开一页设置不需要对话。
 */
export interface SlashCommandContribution {
  /** 命令名（不带 `/`） */
  readonly name: string
  readonly aliases?: readonly string[]
  /** 面板里那一行的说明，写「做什么」 */
  readonly description: string
  readonly order: number
  readonly run: () => void
}
export const slashCommands = defineContributionPoint<SlashCommandContribution>('conversation.slashCommands')

/** 工具调用卡片：按工具名匹配；conversation 自带 omp 内置工具的卡片，其它功能为自己的工具贡献卡片 */
export interface ToolCallRendererProps {
  readonly threadId: string
  /** 这次工具调用的号：跨重渲、跨虚拟列表回收都不变，贡献卡片靠它认「同一个实例」（状态、量过的高度） */
  readonly callId: string
  readonly toolName: string
  readonly args: unknown
  readonly result: unknown | null // 未完成时为 null
  readonly status: 'running' | 'succeeded' | 'failed'
  /**
   * 参数还在流（status 仍是 running）：`args` 是到此为止解析出来的那一份，之后还会再长。只有工具声明了
   * `streamInput` 才会出现（EngineToolSpec）；卡片可以先画个预览，等 succeeded 再当真。
   */
  readonly argsStreaming?: boolean
}
export interface ToolCallRenderer {
  readonly toolName: string | RegExp
  readonly component: ComponentType<ToolCallRendererProps>
  /**
   * 卡片自己就是内容（例如 intelligent-ui 的 intelligent_ui）：不并进过程组，轮次落定后也不折进「过程」；失败的那次照常归过程。
   * 缺省 false —— 普通工具卡片是过程的一部分。
   */
  readonly inline?: boolean
}
export const toolCallRenderers = defineContributionPoint<ToolCallRenderer>('conversation.toolCallRenderers')

/** 输入框草稿：贡献者通过它往草稿里加东西 */
export interface DraftAttachment {
  readonly id: string
  readonly name: string
  readonly kind: 'image' | 'file'
  readonly previewUrl: string | null
}
export interface ComposerDraft {
  readonly threadId: string | null // home 页的新对话为 null
  addAttachments(items: readonly DraftAttachment[]): void
  insertText(text: string): void
  /** 等价于用户点击发送（草稿为空时什么也不做） */
  submit(): void
}
export interface ComposerAction {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<{ draft: ComposerDraft }>
}
export const composerActions = defineContributionPoint<ComposerAction>('conversation.composerActions')

export interface ComposerInputHandler {
  readonly id: string
  /**
   * 这次粘贴归不归我。**必须同步**：要在 Lexical 把文字插入 DOM 之前就答出来（异步回答时它已经插完了）。
   * 认领了再由 onPaste 决定接不接得住，接不住会把文字照原样贴回去。
   */
  claims?(event: ClipboardEvent): boolean
  onPaste?(event: ClipboardEvent, draft: ComposerDraft): boolean | Promise<boolean>
  onDrop?(event: DragEvent, draft: ComposerDraft): boolean | Promise<boolean>
}
export const composerInputHandlers = defineContributionPoint<ComposerInputHandler>('conversation.composerInputHandlers')

export interface ThreadAction {
  readonly id: string
  readonly order: number
  readonly title: string
  /** 行首那枚字形；省略就不画（贡献方可以不认这一格）。 */
  readonly icon?: IconComponent
  readonly run: (thread: Thread) => void | Promise<void>
  readonly visible?: (thread: Thread) => boolean
}
export const threadActions = defineContributionPoint<ThreadAction>('conversation.threadActions')

/*
 * 线程标题栏右侧的小部件（例如 usage 的“累计用量”）。review 的“N 个文件改动”
 * 按钮已按产品负责人 2026-10-07 的决定删除（refactor-log 偏差 #49）。
 */
export interface ThreadHeaderItem {
  readonly id: string
  readonly order: number
  readonly component: SurfaceComponent<{ thread: Thread }>
}
export const threadHeaderItems = defineContributionPoint<ThreadHeaderItem>('conversation.threadHeaderItems')

/**
 * 正文里的本地文件链接点了交给谁（AI 回复里的 `[a.ts](C:\\repo\\a.ts)`、行内代码 `src/a.ts:12`）。
 *
 * 认路径、画链接在 design-system 的正文里；conversation 只知道「这是哪条对话、哪个工作区」，不认识文件 ——
 * 开在右坞的哪一格、怎么预览，归 files 功能。与 composerProviders 同一形制：这里留贡献点，order 最小的那一个接手；
 * 一个都没有时正文里的文件名画成不可点（不退回「用系统默认程序打开」：模型写下的路径不该一点就执行）。
 */
export interface FileReferenceRequest {
  /** 写在正文里的路径，原样：绝对（Windows / UNC / POSIX）或相对（相对于 workspaceId 那个工作区）。 */
  readonly path: string
  readonly line: number | null
  readonly column: number | null
  /** 哪条对话的正文（右坞按它分账）；不在某条对话里（辅助面板等）为 null，接手方按当前前台处理。 */
  readonly threadId: string | null
  /** 相对路径按哪个工作区解析；null 即当前工作区。 */
  readonly workspaceId: string | null
}
export interface FileReferenceOpener {
  readonly id: string
  readonly order: number
  open(request: FileReferenceRequest): void
}
export const fileReferenceOpeners = defineContributionPoint<FileReferenceOpener>('conversation.fileReferenceOpeners')

export interface ConversationUi {
  activeThreadId(): string | null
  subscribeActive(listener: () => void): () => void
  runningCount(): number
  openThread(threadId: string): void
  /** 当前页面上的输入框（home 页或线程页）；没有输入框的页面（例如设置页）返回 null */
  activeComposer(): ComposerDraft | null
  /** 某条线程的输入框草稿，不论它此刻在不在屏幕上 */
  composerOf(threadId: string): ComposerDraft
  /** 以用户消息直接提交到这条线程，不经输入框（用户正在打的字不受影响）；提交失败照常抛出 */
  sendText(threadId: string, text: string): Promise<void>
}
export const ConversationUiToken = defineServiceToken<ConversationUi>('conversation', 'ConversationUi')
