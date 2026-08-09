import { DEFAULT_SURFACE_ID, type SurfaceId } from './surface-registry'

export type WorkbenchTabId = string

/** 一条对话的身份就是它的 thread id：一条对话最多一格。 */
export type ConversationId = string

interface WorkbenchTabBase {
  readonly id: WorkbenchTabId
  readonly title: string
  readonly isActive: boolean
  readonly canClose: boolean
}

export interface ConversationTabViewModel extends WorkbenchTabBase {
  readonly kind: 'conversation'
  readonly threadId: ConversationId
}

export interface SurfaceTabViewModel extends WorkbenchTabBase {
  readonly kind: 'surface'
  readonly surfaceId: SurfaceId
}

export type WorkbenchTabViewModel = ConversationTabViewModel | SurfaceTabViewModel

export interface ActiveConversationViewModel {
  readonly kind: 'conversation'
  readonly tabId: WorkbenchTabId
  readonly threadId: ConversationId
  readonly title: string
}

export interface SurfaceViewModel {
  readonly kind: 'surface'
  readonly tabId: WorkbenchTabId
  readonly surfaceId: SurfaceId
  readonly title: string
}

export type WorkbenchSurfaceViewModel = ActiveConversationViewModel | SurfaceViewModel

/**
 * 工作台快照。
 *
 * 标签与活动表面是同一份投影的两个面，没有第三个字段。此前另有两个只服务
 * 文档域的镜像字段，与活动表面说的是同一件事，靠三条不变量互相看住——那几条
 * 不变量的存在本身就是"同一真相存了三份"的证据。
 */
export interface WorkbenchViewModel {
  readonly activeTabId: WorkbenchTabId
  readonly tabs: readonly WorkbenchTabViewModel[]
  readonly activeSurface: WorkbenchSurfaceViewModel
}

/**
 * 打开一个表面。
 *
 * 只收 id：标题是 registry 已经拥有的事实，让调用方再传一遍就是让同一个
 * 值有两个来源——此前 WorkspaceShell 正是靠 describeSurface(id).title
 * 把查出来的值又喂了回去。
 */
export interface OpenSurfaceRequest {
  readonly surfaceId: SurfaceId
}

export interface OpenConversationRequest {
  readonly threadId: ConversationId
  readonly title: string
}

export interface WorkbenchSessionCommands {
  readonly openSurface: (request: OpenSurfaceRequest) => void

  /**
   * 打开一条已有对话。
   *
   * id 固定为 conversation:<threadId>，所以一条对话最多只有一格，已经开着时
   * 只激活它。正在看的那一格本身就是 AI 时就地替换：侧栏是导航，不是标签
   * 工厂。其它形态一律插在活动标签右侧。
   */
  readonly openConversation: (request: OpenConversationRequest) => void

  /** 「在新标签页打开」：永远追加一格，从不顶掉正在看的那一格。 */
  readonly openConversationInNewTab: (request: OpenConversationRequest) => void

  /** 官方标题到达后改写标签标题；同值直接返回。 */
  readonly setConversationTitle: (threadId: ConversationId, title: string) => void

  readonly activateTab: (tabId: WorkbenchTabId) => void
  readonly closeTab: (tabId: WorkbenchTabId) => void

  /**
   * 这条对话不存在了：开着它的那一格跟着消失。
   *
   * 与 closeTab 不是同一件事。closeTab 说的是「人按了叉」，身份是标签；
   * 这里说的是「这条对话没了」，身份是 threadId —— 调用方不必知道它此刻
   * 有没有被提升成标签，也不必自己去拼 tab id。正在看着它时按标签条的
   * 顺序落到邻居上，一格都不剩就回到「新建对话」。
   */
  readonly closeConversation: (threadId: ConversationId) => void
  readonly moveTab: (tabId: WorkbenchTabId, targetIndex: number) => void
}

export interface WorkbenchSessionStore extends WorkbenchSessionCommands {
  readonly getSnapshot: () => WorkbenchViewModel
  readonly subscribe: (listener: () => void) => () => void
}

/**
 * 默认表面那一格的标签 id。
 *
 * 由默认表面 id 派生，不另立字面量：controller 的 entryId() 拼的是同一条规则，
 * 两处对不上就是一格永远激活不了的标签。首帧快照由 project(INITIAL_STATE) 给出，
 * 这里不再手写第二份。
 */
export const DEFAULT_SURFACE_TAB_ID: WorkbenchTabId = `surface:${DEFAULT_SURFACE_ID}`
