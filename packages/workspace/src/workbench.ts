import type { SurfaceId } from './surface-registry'

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

export interface WorkbenchSessionStore {
  readonly getSnapshot: () => WorkbenchViewModel
  readonly subscribe: (listener: () => void) => () => void
  readonly openSurface: (request: OpenSurfaceRequest) => void
  readonly openConversation: (request: OpenConversationRequest) => void
  readonly openConversationInNewTab: (request: OpenConversationRequest) => void
  readonly activateTab: (tabId: WorkbenchTabId) => void
  readonly closeTab: (tabId: WorkbenchTabId) => void
  readonly closeConversation: (threadId: ConversationId) => void
  readonly moveTab: (tabId: WorkbenchTabId, targetIndex: number) => void
}
