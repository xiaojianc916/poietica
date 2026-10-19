import { createValue } from '@poietica/ui-kernel'
import { createDraftPin, type DraftPinView } from '../composer/draft-pin'
import type { ConversationTodoThread } from '../session/conversation-controls'
import { shouldNotify } from '../session/notify'
import { leaveForArchive } from '../threads/thread-lifecycle'
import type { ConversationSetup } from './context'

/** 活动线程、打开 / 导出 / 新建线程、侧栏折叠、归档横幅、通知。 */
export interface ConversationActions {
  readonly todoThread: ReturnType<typeof createValue<string | null>>
  readonly activeThreadId: () => string | null
  readonly subscribeActive: (listener: () => void) => () => void
  readonly openThread: (threadId: string) => void
  readonly newThread: (workspaceId?: string) => void
  /**
   * 归档一条对话。**归档的正是当前这条**时回到入口页 —— 停在一个已经不在活动列表里的会话上
   * 是自相矛盾的：侧栏没有它的行、内容却还占着主区。归档别的对话不影响当前页面。
   */
  readonly archiveThread: (threadId: string) => void
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
   * 草稿落盘（`conversation.drafts`）。**每一格**草稿都要记住 —— 正文 / 附件 / 技能，以及入口页那排选择器的值。
   * 少写这一条，重开软件后入口页的选择就回到默认（真实故障）。写盘去抖：Host 的 `uiState.set` 已经走 500ms 的 saveDebounced，这一层只把「一串变更」并成一次提交。
   */
  let draftWrite: ReturnType<typeof setTimeout> | null = null
  /* 草稿附件的只读视图（R-07 §3.4）：attachments 的 UI 拿它做引用登记。 */
  const draftPin = createDraftPin(stores.composer)
  const persistDrafts = (): void => {
    if (draftWrite !== null) clearTimeout(draftWrite)
    draftWrite = setTimeout(() => {
      draftWrite = null
      /*
       * 盘上那份还没读回来之前一律不写：此刻的快照不含盘上的选择器，写进 Host 的 uiState 就把用户上次的选择盖掉了，
       * 随后的 `uiState.get` 读回的是被盖过的那份（真实故障：入口页选择时好时坏地丢）。恢复之后的第一次变更（hydrate 本身）
       * 会再排一次写盘，把恢复前敲的字一并带上。
       */
      if (!draftPin.restored()) return
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

  /* 任务浮层开着的是哪条对话。它不属于外壳的布局意图（不落盘、不开栅格格位），所以由 conversation 自己用 ui-kernel 的最小可订阅值持有 —— 不存在第二个真相。 */
  const todoThread: ConversationTodoThread = createValue<string | null>(null)
  /*
   * 当前线程 = **路由的派生**，不是另存的一份状态。原先它是只在 openThread 里赋值的变量：从别的路径回到入口页时没人清它，
   * 侧栏那一行于是在入口页仍然亮着（真实故障）。唯一判据是路由：停在线程页才有当前线程。
   */
  const activeThreadOfRoute = (): string | null => {
    const { route } = navigation.current()
    return route.surface === 'conversation.thread' ? (route.params.threadId ?? null) : null
  }
  const activeListeners = new Set<() => void>()
  /* 对外说「当前是哪条线程」时一律现算：它是路由的派生，另存就会有「某条跳转路径忘了同步」的残留。 */
  const activeThreadId = (): string | null => activeThreadOfRoute()
  const syncActiveThread = (): void => {
    for (const l of [...activeListeners]) l()
  }
  ctx.lifecycle.onDispose(navigation.subscribe(syncActiveThread))
  /* 侧栏的组折叠也要**可订阅**：就地 mutate 一个 Set 不会让任何人重画（真实故障：点文件夹组头没有任何反应）。 */
  const collapsed = createValue<ReadonlySet<string>>(new Set())

  /*
   * 刚归档的那条对话与它的编号。归档是**可逆**的，而那一行已从列表上消失，没有横幅就只剩设置里那一页能找回来；
   * 序号让同一个动作重来一次时横幅重新计时。这一段是 setup 装配（不在 React 渲染期），所以用一份可订阅值，组件里 useObservable 订阅着读。
   */
  const archived = createValue<{ threadId: string; seq: number } | null>(null)

  /* 去看看已归档：横幅先撤，再打开设置那一页 —— 不然它会在设置上面又飘四秒。 */
  const showArchived = (): void => {
    archived.set(null)
    navigation.navigate({ surface: 'workbench.settings', params: { page: 'conversation.archived' } })
  }

  /* 运行中的线程号（纯函数版，给命令与回调用）。这两处不在渲染期，读一次快照是对的。 */
  const runningThreadIds = (): ReadonlySet<string> =>
    new Set(
      Object.values(stores.turnStates.store.getState().byThread)
        .filter((s) => s.state !== 'idle')
        .map((s) => s.threadId),
    )

  /*
   * 系统通知。三种场合：一轮结束（完成 / 失败）、需要确认、以及**点通知跳回那条对话**。
   * `NeedConfirm` 不吃 `notifyOnCompletion` —— 那只管「跑完了没」，压掉它用户就永远不知道 agent 卡在那里等。
   */
  const notify = (threadId: string, body: string, kind: 'completion' | 'needs-confirm'): void => {
    /* 定时任务开的对话由 automations 自己通知（R-16）；这里再发一遍，用户会对同一件事收到两条，而且「从不通知」的任务也会响。 */
    if (stores.threads.byId(threadId)?.origin === 'automation') return
    if (kind === 'completion') {
      if (!shouldNotify(!document.hasFocus(), prefs.current().general.notifyOnCompletion)) return
    }
    const title = stores.threads.byId(threadId)?.title ?? '对话'
    void platform.call('notify.show', { title, body, threadId }).catch(() => undefined)
  }

  const openThread = (threadId: string): void => {
    /* 高亮由路由派生，这里只负责导航。 */
    navigation.navigate({ surface: 'conversation.thread', params: { threadId } })
    void api.openThread(threadId).catch(() => undefined)
    /*
     * `threads.open` 只做「后台预热会话」，不返回控件表；表要等 Core 的 `controls.changed` 通知。
     * 只等通知的话，那一排选择器（模型 / 思考 / 批准方式）在预热完成之前一直不画 —— 用户看到的就是「没有权限选择与模型选择」（真实故障）。这里主动问一次，通知到了再覆盖。
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
   * 「新建对话」= **打开入口页**，不是当场建一条线程：号由入口页发出第一句话时的 `prepare()` 铸，**没有**「先建空线程」这一步。
   * 原先这里直接 `createThread` + `openThread`：点一次加号就落一条标题为「新对话」的空线程（真机实测：点两下，库里多两条 `title_source = pending` 的行）。
   * 不点名工作区就是「当前那个」；点了名就先切过去。
   */
  const newThread = (workspaceId?: string): void => {
    if (workspaceId !== undefined) {
      workspaces.setActive(workspaceId)
    }
    /* 入口页没有当前会话：导航一落地，activeThreadId 就由路由派生回 null。 */
    navigation.navigate({ surface: 'conversation.home', params: {} })
  }

  /*
   * 归档 = 移出活动列表。当前页面若正是这一条，导航必须先走：留在那儿的话，主区显示的是一条
   * 侧栏上已经不存在的会话，再点别的对话才把它挤掉。判据是路由派生的 activeThreadId ——
   * 与侧栏高亮同一份事实，不存在「跳转路径忘了同步」的第二种当前会话。
   *
   * 先导航后请求：setArchived 失败时用户已经落在入口页，但那条对话还在列表里（什么都没丢）。
   * 反过来先请求再导航，会有一小段时间停在一个已归档的会话上。
   */
  const archiveThread = (threadId: string): void => {
    if (leaveForArchive(activeThreadId(), threadId)) newThread()
    void api.setArchived(threadId, true).then((t) => {
      stores.threads.upsert(t)
      archived.set({ threadId, seq: (archived.current()?.seq ?? 0) + 1 })
    })
  }

  return {
    activeThreadId,
    archiveThread,
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
