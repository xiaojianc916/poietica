import { defineServiceToken } from '@poietica/foundation'
import { defineContributionPoint, type SurfaceComponent } from '@poietica/ui-kernel'
import type { ComponentType, ReactNode } from 'react'
import type { Thread } from '../contract'

/*
 * 输入框草稿的资产形状与「谁来把它们弄进来」的接口。
 *
 * 这两样同时被 conversation 的输入框（消费方）与 attachments 的入库实现（提供方）
 * 用到，而两个功能之间只能经 contract / core-api / ui-api 协作（守则 3），所以它们
 * 住在 ui-api 这一格。`ui/composer/attachment.ts` 与 `ui/components/composer/attachment-intake.ts`
 * 各留一层转发，legacy 迁入的组件 import 路径不必全改。
 */
export {
  type AttachmentIntake,
  AttachmentIntakeContext,
  type AttachmentUpload,
  type ComposerAsset,
  type ComposerAssetContext,
  isInlineAttachment,
  useAttachmentIntake,
} from './composer-assets'

/*
 * 工作区/分支选择器本体也从这个子入口出去。
 *
 * 它画在**输入框下方那一行上下文**里（legacy 的 composer-context），而那一行的数据
 * （当前分支、分支名单、切换与新建）属于 review —— review 不能 import conversation 的
 * `ui`（feature-cross-impl），所以组件住在这里、由 review 取用（03 页 §4.4）。
 */
export { GitBranchPicker, type GitBranchPickerProps } from './git-branch-picker'

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
/**
 * 输入框下方那一行的其它 chip（03 页 §4.4 的跨功能扩展）。
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
 * 输入框树的外层提供者（03 页 §4.4）。
 *
 * 附件的入库口（AttachmentIntake）由 attachments 提供：它认识 dialog.pickFiles 与
 * attachments.importPaths，而 conversation 的 `ui` 不能 import 它（features 之间只能经
 * contract / core-api / ui-api 协作）。于是 conversation 在树里留一个插槽，attachments
 * 往里面放一个 Provider —— 这是双向都合法的接法（attachments 取本文件的令牌与 Context）。
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

/** 工具调用卡片：按工具名匹配；conversation 自带 omp 内置工具的卡片，其它功能为自己的工具贡献卡片 */
export interface ToolCallRendererProps {
  readonly threadId: string
  readonly toolName: string
  readonly args: unknown
  readonly result: unknown | null // 未完成时为 null
  readonly status: 'running' | 'succeeded' | 'failed'
}
export interface ToolCallRenderer {
  readonly toolName: string | RegExp
  readonly component: ComponentType<ToolCallRendererProps>
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
  onPaste?(event: ClipboardEvent, draft: ComposerDraft): boolean | Promise<boolean>
  onDrop?(event: DragEvent, draft: ComposerDraft): boolean | Promise<boolean>
}
export const composerInputHandlers = defineContributionPoint<ComposerInputHandler>('conversation.composerInputHandlers')

export interface ThreadAction {
  readonly id: string
  readonly order: number
  readonly title: string
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
 * 草稿引用的附件：给 attachments 的 UI 做引用登记（R-07 §3.4）。
 *
 * conversation 不认识 attachments，只交出这份只读视图；整体替换的登记由 attachments
 * 那一侧调自己的契约完成。
 */
export interface DraftAttachments {
  /**
   * 全部草稿（每条线程 + 入口页）引用的附件 id，去重、升序。
   *
   * **草稿还没从盘上恢复时为 null**：attachments 的 onCoreReady 可能先于草稿读盘，
   * 那一刻拿空集合去整体替换会把盘上草稿的引用全部清掉。
   */
  ids(): readonly string[] | null
  /** id 集合变化时回调（打字不触发）；恢复完成时也回调一次 */
  subscribe(listener: () => void): () => void
  /** 从所有草稿里移除这些附件，返回实际移除的条数 */
  drop(ids: readonly string[]): number
}

export interface ConversationUi {
  activeThreadId(): string | null
  subscribeActive(listener: () => void): () => void
  runningCount(): number
  openThread(threadId: string): void
  /** 当前页面上的输入框（home 页或线程页）；没有输入框的页面（例如设置页）返回 null */
  activeComposer(): ComposerDraft | null
  readonly draftAttachments: DraftAttachments
}
export const ConversationUiToken = defineServiceToken<ConversationUi>('conversation', 'ConversationUi')

/**
 * 技能文档：看到一份 SKILL.md。
 *
 * legacy 里这件事由宿主的 `auxiliaryPanel.openFile('settings', 'skill:<id>')` 干，面板本体
 * 住在 `apps/desktop/src/workbench/skill-document-pane.tsx`。新架构里右栏面板由功能经
 * `panels` 贡献点注入，而**能画 markdown 的那一套排版（Prose）属于 conversation**
 * （守则 3：功能之间不得互相 import ui），所以面板住在 conversation，extensions 只把
 * 「人要看这一份」说出来 —— 与 legacy 的分工一字不差。
 */
/** SKILL.md 的 frontmatter 读出来的那几格。解析在 extensions 侧做（它认识技能包），
 * 这里只声明跨功能要传的形状。 */
export interface SkillDocumentFacts {
  readonly name: string
  readonly description: string | undefined
  readonly body: string
  readonly type: string | undefined
  readonly whenToUse: string | undefined
  readonly disableModelInvocation: boolean
  /** SKILL.md 自己报的毛病（缺 frontmatter、没写 name……），与 legacy 的 issues 同义。 */
  readonly issues: readonly string[]
}
export interface SkillDocument {
  readonly markdown: string
  readonly name: string
  /** 名册里报的那条路径：可能是 SKILL.md 本身，也可能只是目录。 */
  readonly path: string
  readonly facts: SkillDocumentFacts
}
export interface SkillDocumentPort {
  /** 打开右侧「技能文档」面板并换成这一份；面板已经开着就只换内容。 */
  open(document: SkillDocument): void
}
export const SkillDocumentToken = defineServiceToken<SkillDocumentPort>('conversation', 'SkillDocument')
