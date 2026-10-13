import { createValue } from '@poietica/ui-kernel'
import type { ConversationTodoThread } from '../components/conversation-controls'
import { createDraftPin, type DraftPinView } from '../composer/draft-pin'
import { shouldNotify } from '../session/notify'
import type { ConversationSetup } from './context'

/** 活动线程、打开 / 导出 / 新建线程、侧栏折叠、归档横幅、通知。 */
export interface ConversationActions {
  readonly todoThread: ReturnType<typeof createValue<string | null>>
  readonly activeThreadId: () => string | null
  readonly subscribeActive: (listener: () => void) => () => void
  readonly openThread: (threadId: string) => void
  readonly newThread: (workspaceId?: string) => void
  readonly exportThread: (threadId: string) => Promise<void>
  readonly showArchived: () => void
  readonly notify: (threadId: string, body: string, kind: 'completion' | 'needs-confirm') => void
  readonly runningThreadIds: () => ReadonlySet<string>
  readonly draftPin: DraftPinView
  readonly collapsed: ReturnType<typeof createValue<ReadonlySet<string>>>
  readonly archived: ReturnType<typeof createValue<{ threadId: string; seq: number } | null>>
}

export function createConversationActions(setup: ConversationSetup): ConversationActions {
  const { api, ctx, navigation, platform, preferences, prefs, stores, toasts, workspaces } = setup

  /*
   * 草稿落盘（07 页 §5E：`conversation.drafts`）。**每一格**草稿都要记住 ——
   * 正文 / 附件 / 技能，以及入口页那排选择器的值（`{ model, thinking, posture }`）。
   * 少写这一条，重开软件后入口页的选择就回到默认（真实故障）。
   *
   * 写盘去抖：这块 store 在打字时每一下都在变，逐字符往返一次 RPC 是白费；
   * Host 侧的 `uiState.set` 本身也已经走 500ms 的 saveDebounced（08 页 §6.2），
   * 这一层只把「一串变更」并成一次提交。
   */
  let draftWrite: ReturnType<typeof setTimeout> | null = null
  /* 草稿附件的只读视图（R-07 §3.4）：attachments 的 UI 拿它做引用登记 */
  const draftPin = createDraftPin(stores.composer)
  const persistDrafts = (): void => {
    if (draftWrite !== null) clearTimeout(draftWrite)
    draftWrite = setTimeout(() => {
      draftWrite = null
      const snapshot = stores.composer.snapshot()
      void preferences.call('uiState.set', { key: 'conversation.drafts', value: snapshot }).catch((cause) => {
        ctx.logger.warn('drafts persist failed', { error: String(cause) })
      })
    }, 300)
  }
  ctx.lifecycle.onDispose(
    stores.composer.store.subscribe(() => {
      persistDrafts()
      draftPin.onChange()
    }),
  )

  /*
   * 任务浮层开着的是哪条对话。legacy 是 workspace-layout store 里的一格（todoThread），
   * 新架构里它不属于外壳的布局意图（不落盘、不开栅格格位），所以由 conversation 自己
   * 用 ui-kernel 的最小可订阅值持有：两枚开关与浮层读同一份，不存在第二个真相。
   */
  const todoThread: ConversationTodoThread = createValue<string | null>(null)
  /*
   * 当前线程 = **路由的派生**，不是另存的一份状态。
   *
   * 原先它是一个只在 openThread 里赋值的变量：从别的路径回到入口页（点「新建对话」、
   * 后退、开机恢复路由）时没人清它，侧栏那一行于是在入口页仍然亮着（真实故障）。
   * 现在唯一的判据是路由：停在线程页才有当前线程，其余页面一律 null。
   */
  const activeThreadOfRoute = (): string | null => {
    const { route } = navigation.current()
    return route.surface === 'conversation.thread' ? (route.params.threadId ?? null) : null
  }
  const activeListeners = new Set<() => void>()
  /*
   * 对外（`ConversationUiToken` 与命令）说「当前是哪条线程」时，一律现算：它是路由的
   * 派生，不是另存的一份状态。另存就会有「某条跳转路径忘了同步」的残留。
   */
  const activeThreadId = (): string | null => activeThreadOfRoute()
  const syncActiveThread = (): void => {
    for (const l of [...activeListeners]) l()
  }
  ctx.lifecycle.onDispose(navigation.subscribe(syncActiveThread))
  /* 侧栏的组折叠也要**可订阅**：就地 mutate 一个 Set 不会让任何人重画（真实故障：
   * 点文件夹组头没有任何反应）。 */
  const collapsed = createValue<ReadonlySet<string>>(new Set())

  /*
   * 刚归档的那条对话，以及它的编号。留着是为了给出一句「会话已归档」和一条撤销 ——
   * 与 legacy 的 assistant-sidebar-panel 同一条：归档是**可逆**的，而那一行已经从列表上
   * 消失，没有横幅就只剩设置里那一页能找回来。序号让同一个动作重来一次时横幅重新计时
   * （key 变了才重挂，见 Banner 头注）。
   *
   * 它不能像 legacy 那样写成组件里的 useState：这一段是 setup 装配（不在 React 渲染期），
   * 所以与 collapsed 同一条路 —— 一份可订阅值，组件里 useObservable 订阅着读。
   */
  const archived = createValue<{ threadId: string; seq: number } | null>(null)

  /* 去看看已归档：横幅先撤，再打开设置那一页 —— 不然它会在设置上面又飘四秒。 */
  const showArchived = (): void => {
    archived.set(null)
    navigation.navigate({ surface: 'workbench.settings', params: { page: 'conversation.archived' } })
  }

  /*
   * 运行中的线程号（纯函数版，给命令与回调用；**组件里**一律走 useRunningThreadIds）。
   * 这两处不在渲染期，读一次快照是对的。
   */
  const runningThreadIds = (): ReadonlySet<string> =>
    new Set(
      Object.values(stores.turnStates.store.getState().byThread)
        .filter((s) => s.state !== 'idle')
        .map((s) => s.threadId),
    )

  /*
   * 系统通知（07 页 §5E 的通知表；14 页 §9 第 7 条）。
   *
   * 三种场合：一轮结束（完成 / 失败）、需要确认、以及**点通知跳回那条对话**。
   * `NeedConfirm` 不吃偏好那一格 —— `notifyOnCompletion` 只管「跑完了没」，需要人
   * 回应是另一件事，压掉它用户就永远不知道 agent 卡在那里等（legacy 同此）。
   */
  const notify = (threadId: string, body: string, kind: 'completion' | 'needs-confirm'): void => {
    /*
     * 定时任务开的对话由 automations 自己通知（审查 R-16：按任务的通知策略，在
     * automations/core/notice.ts 判）。这里再发一遍，用户会对同一件事收到两条、
     * 而且「从不通知」的任务也会响。
     */
    if (stores.threads.byId(threadId)?.origin === 'automation') return
    if (kind === 'completion') {
      if (!shouldNotify(!document.hasFocus(), prefs.current().general.notifyOnCompletion)) return
    }
    const title = stores.threads.byId(threadId)?.title ?? '对话'
    void platform.call('notify.show', { title, body, threadId }).catch(() => undefined)
  }

  const openThread = (threadId: string): void => {
    /* 高亮由路由派生（见 activeThreadOfRoute 的头注），这里只负责导航。 */
    navigation.navigate({ surface: 'conversation.thread', params: { threadId } })
    void api.openThread(threadId).catch(() => undefined)
    /*
     * 打开线程顺手把控件表拉回来。
     *
     * `threads.open` 只做「后台预热会话」，它不返回控件表；表要等 Core 的
     * `controls.changed` 通知（会话真的起来之后才有）。只等通知的话，屏幕上那一排
     * 选择器（模型 / 思考 / 批准方式）在预热完成之前一直不画 —— 用户看到的就是
     * 「没有权限选择与模型选择」（真实故障）。这里主动问一次，通知到了再覆盖。
     */
    void stores.controls.refresh(threadId)
    const thread = stores.threads.byId(threadId)
    if (thread !== undefined) workspaces.setActive(thread.workspaceId)
  }

  const exportThread = async (threadId: string): Promise<void> => {
    const thread = stores.threads.byId(threadId)
    if (thread === undefined) return
    const picked = await platform.call('dialog.pickSavePath', {
      defaultName: `${thread.title}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (picked.path === null) return
    try {
      await api.exportThread({ threadId, format: 'markdown', targetPath: picked.path })
      toasts.show({ severity: 'success', title: '已导出' })
    } catch (e) {
      toasts.error(e)
    }
  }

  /*
   * 「新建对话」= **打开入口页**，不是当场建一条线程。
   *
   * legacy 的这一格（`assistant-sidebar-panel.tsx` 的 `create`）做两件事：先
   * `setActiveWorkspaceRoot(workspaceId)`，再 `openAssistantSurface()`（= 打开 'ai'
   * 表面）。号由入口页发出第一句话时的 `prepare()` 铸（07 页 §5E 的乐观提交），
   * **没有**「先建一条空线程再让用户说话」这一步。
   *
   * 原先这里直接 `createThread` + `openThread`：点一次工作区右侧的加号就落一条
   * 标题为「新对话」、一句话都没有的空线程（真机实测：点两下，库里多两条
   * `title_source = pending` 的行）。这与 legacy 的形制不符，也已记入 refactor-log。
   *
   * 不点名工作区（命令面板 / Ctrl+N）就是「当前那个」：入口页自己会取
   * `WorkspacesUi.active()`，所以这里保持原状即可。点了名就先切过去 —— 与 legacy
   * 的 `setActiveWorkspaceRoot` 同序，入口页读到的便是刚点的那一个。
   */
  const newThread = (workspaceId?: string): void => {
    if (workspaceId !== undefined) {
      workspaces.setActive(workspaceId)
    }
    /* 入口页没有当前会话：导航一落地，activeThreadId 就由路由派生回 null。 */
    navigation.navigate({ surface: 'conversation.home', params: {} })
  }

  return {
    activeThreadId,
    archived,
    collapsed,
    draftPin,
    exportThread,
    newThread,
    notify,
    openThread,
    runningThreadIds,
    showArchived,
    subscribeActive: (listener) => {
      activeListeners.add(listener)
      return () => {
        activeListeners.delete(listener)
      }
    },
    todoThread,
  }
}
