import { Banner, ConfirmationDialog } from '@poietica/design-system'
import { prefetchProseWhenIdle } from '@poietica/design-system/prose'
import { useWorkspacesView } from '@poietica/feature-workspaces/ui-api'
import {
  builtinPoints,
  SETTINGS_GROUPS,
  useFeatureStore,
  useFeatureStoreShallow,
  useNavigation,
  useObservable,
} from '@poietica/ui-kernel'
import { Archive, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ConversationProviders } from '../composition'
import { AssistantSurface } from '../home/assistant-surface'
import { HomeSurface } from '../home/home-surface'
import { useThreadCommands } from '../session/commands'
import {
  effectiveUsage,
  hiddenModelsOf,
  PLAN_CONTROL_ID,
  PLAN_ENABLED,
  postureOfControl,
  sessionConfigControlsOf,
  sessionGoalOf,
  withoutHiddenModels,
} from '../session/configuration/control-shapes'
import { ConversationAuxiliaryToggle, ConversationTodoToggle } from '../session/conversation-controls'
import { ArchivedChatsPage } from '../session/settings/archived-page'
import { GOAL_CONTROL_ID, GOAL_DISABLED } from '../shared/model/goal-control'
import { groupByWorkspace } from '../shared/model/thread-order'
import type { TimelineState } from '../shared/timeline/timeline-contract'
import { runGoalAction } from '../status/goal/goal-actions'
import { useThreadSessionLifecycle } from '../threads/thread-lifecycle'
import { AssistantThreadList } from '../threads/view/assistant-thread-list'
import { NewConversationNavRow } from '../threads/view/new-conversation-nav-row'
import { ARCHIVED_FILTER, type ArchivedFilter } from '../threads/view/thread-view'
import { openSubagentTab } from '../timeline/view/subagent-dock'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'
import { useCompletionUnreadIds, useRunningThreadIds } from './use-running-thread-ids'

/** 界面、侧栏、面板等贡献。 */
export function createConversationContributions(setup: ConversationSetup, actions: ConversationActions): void {
  const {
    api,
    ctx,
    entryDefaults,
    layout,
    liveComposers,
    posture,
    prefs,
    sessions,
    stores,
    subagentTabs,
    transcripts,
    workspaces,
  } = setup
  const {
    archiveThread,
    archived,
    collapsed,
    exportThread,
    newThread,
    openThread,
    shareThread,
    showArchived,
    todoThread,
  } = actions
  /*
   * 点一下就发出去的那些调用（置顶、改名、分叉、换模型……）没有人在等结果：失败至少记一条带上下文的 warn（AGENTS.md §8.1）。
   * 屏幕不用回滚 —— 这些都不是乐观更新，失败了屏幕上本来就还是旧值；控件表另由 controls.changed 推回真值。
   */
  const failed =
    (action: string, threadId: string) =>
    (cause: unknown): void => {
      ctx.logger.warn('conversation action failed', { action, threadId, error: String(cause) })
    }
  /* 线程表面挂载 / 换对话时主动问一次控件表（审查 R-19-4，判据见 thread-lifecycle.ts）。setup 级的稳定引用：它进了 effect 依赖。 */
  const refreshControls = (threadId: string): Promise<void> => stores.controls.refresh(threadId)

  /* 重写分出来的新对话要带上的那一句：按新对话号放一次、取一次（setup 级，跨表面实例） */
  const prefills = new Map<string, string>()
  /* 入口页执行的斜杠命令：对话刚铸出来、表面还没挂上，按对话号放一次，由那条对话的表面订阅好输出后取走执行 */
  const pendingCommands = new Map<string, string>()
  const startCommand = (threadId: string, text: string): void => {
    pendingCommands.set(threadId, text)
    openThread(threadId)
  }
  const takePendingCommand = (threadId: string): string | undefined => {
    const text = pendingCommands.get(threadId)
    pendingCommands.delete(threadId)
    return text
  }
  const rewriteThread = (threadId: string, turn: number) => {
    const text = promptOfTurn(transcripts.read(threadId).timeline, turn)
    void api
      .forkThread({ threadId, keepTurns: turn - 1 })
      .then((t) => {
        stores.threads.upsert(t)
        if (text !== '') prefills.set(t.id, text)
        openThread(t.id)
      })
      .catch(failed('rewrite', threadId))
  }

  /*
   * 正文排版（streamdown / shiki / pele）在独立分块里，不进首屏入口闭包（性能方案 P5）。入口页是开机必经的第一屏、
   * 本身一个字的正文都不画：在它画完之后的空闲里预取，第一段正文上屏前就已到位。会话页也调一次（同一次启动只排一次）。
   */
  const prefetchProse = (): void => {
    prefetchProseWhenIdle((cause: unknown) => {
      ctx.logger.warn('正文排版模块没能加载，正文将按源码显示', { error: String(cause) })
    })
  }

  /* 侧栏导航「新建对话」归 conversation —— 这个功能才知道入口在哪儿，外壳一个产品常量都不写。 */
  ctx.contribute(builtinPoints.sidebarSections, {
    id: 'conversation.new',
    order: 5,
    title: '新建对话',
    icon: SquarePen,
    placement: 'nav',
    component: () => <NewConversationNavRow />,
  })

  ctx.contribute(builtinPoints.sidebarSections, {
    id: 'conversation.threads',
    order: 20,
    title: '项目',
    component: () => {
      /*
       * 必须**订阅**着读，且选择器必须交回**稳定引用**。读快照是一次性的：store 还空着时渲染一遍就再也不会重画。
       * 选择器造新数组更糟 —— useShallow 比的是元素，React 会一路重渲染到 "Maximum update depth exceeded"
       * （真机实测：发出第一句话、列表长出第一行之后，整个侧栏那段当场被错误边界接管）。所以选 `s.items` 本身，行形状在外层 useMemo 派生。
       */
      const threads = useFeatureStore(stores.threads.store, (s) => s.items)
      /*
       * 跑完还没点开的那几条（绿点）。要在派生行形状之前读：`items` 的 useMemo 依赖它，
       * 否则绿点亮了、行形状没变，memo 不会重算。
       */
      const doneUnreadIds = useCompletionUnreadIds(stores.completionUnread)
      const items = useMemo(
        () =>
          threads
            /*
             * 这里不再过滤归档：归档是视图选项里的一档（隐藏 / 一起显示 / 只看它们），由列表按行上的
             * record.archived 一处判。查询那一侧跟着档位换（setIncludeArchived 之后重读），列表于是拿得到
             * 它要画的那一份；两层各筛一次，就会出现「档位说显示、列表里却没有」。
             */
            .map((thread) => ({
              id: thread.id,
              title: thread.title,
              isPinned: thread.pinned,
              pendingInteraction: thread.pendingInteraction,
              isDoneUnread: doneUnreadIds.has(thread.id),
              updatedAt: new Date(thread.updatedAt).toISOString(),
              workspaceId: thread.workspaceId,
              record: thread,
            })),
        [threads, doneUnreadIds],
      )
      const state = useFeatureStoreShallow(stores.threads.store, (s) => ({
        isLoading: s.isLoading,
        failure: s.failure,
      }))
      /* 项目名单与运行中标记同样**订阅**着读：两者都要等一次往返才有值，读快照就再也不重画。 */
      const view = useWorkspacesView(workspaces)
      const runningIds = useRunningThreadIds(stores.turnStates)
      /*
       * 高亮**直接从路由读**：停在线程页才有当前线程。直接从导航读就不存在「某条跳转路径没触发通知」的残留 —— 这才是侧栏高亮反复修不好的真原因。
       */
      const { route } = useNavigation()
      const active = route.surface === 'conversation.thread' ? (route.params.threadId ?? null) : null
      /*
       * 停在一条会话上就等于「看过了」：启动时恢复出来的路由不会经过 openThread，
       * 所以这里也收一次绿点。判据是本组件**画到屏幕上**的那一条，而不是别处记的当前页 ——
       * 侧栏没挂载时（设置页）不该把任何一条当成已看。
       */
      useEffect(() => {
        stores.completionUnread.consume(active)
      }, [active])
      const collapsedWorkspaces = useObservable(collapsed)
      /*
       * 归档那一档要**换一次查询**（threads.list 带 includeArchived），所以它住在这里、不在列表的草稿里：
       * 只切本地视图的话，「一起显示」拿不到任何已归档的行，「只看它们」永远是空的。
       */
      const [archivedFilter, setArchivedFilter] = useState<ArchivedFilter>(ARCHIVED_FILTER.hide)
      /* 归档横幅同样订阅着读：读到快照的话 set 之后这一格不会重画。 */
      const archivedNotice = useObservable(archived)
      /* 组名从工作区表查：`thread.workspaceId` 是实体 id 不是路径，用「路径末段」猜只会得到 uuid。 */
      const grouped = groupByWorkspace(items, (workspaceId) => {
        const workspace = view.items.find((w) => w.id === workspaceId)
        return workspace?.name ?? null
      })
      /*
       * 还没有对话的项目也要出现在侧栏（用户 2026-10-20）。有对话的组沿用 groupByWorkspace 的
       * 最近活动序，空项目接在后面并保持工作区表的顺序 —— 它们同样要有组头，删除入口才在。
       */
      const groupedIds = new Set(grouped.map((group) => group.id))
      const allGroups = [
        ...grouped,
        ...view.items
          .filter((workspace) => !groupedIds.has(workspace.id))
          .map((workspace) => ({ id: workspace.id, name: workspace.name, items: [] })),
      ]
      const [removing, setRemoving] = useState<{ readonly id: string; readonly name: string } | null>(null)
      return (
        <>
          <AssistantThreadList
            activeThreadId={active}
            archivedFilter={archivedFilter}
            collapsedWorkspaces={collapsedWorkspaces}
            failure={state.failure}
            groups={allGroups}
            isLoading={state.isLoading}
            onActivate={openThread}
            onArchive={archiveThread}
            onAddWorkspace={() => void workspaces.pickAndAdd()}
            onArchivedFilterChange={(value) => {
              setArchivedFilter(value)
              stores.threads.setIncludeArchived(value !== ARCHIVED_FILTER.hide)
              void stores.threads.refresh()
            }}
            onCreate={newThread}
            onRemoveWorkspace={(workspaceId) => {
              const workspace = view.items.find((w) => w.id === workspaceId)
              if (workspace !== undefined) setRemoving({ id: workspace.id, name: workspace.name })
            }}
            onPin={(threadId, pinned) => {
              void api
                .setPinned(threadId, pinned)
                .then((t) => stores.threads.upsert(t))
                .catch(failed('pin', threadId))
            }}
            onToggleWorkspace={(workspaceId) => {
              /* 换一份新 Set 再 set：可订阅值按引用判变化。 */
              const next = new Set(collapsed.current())
              if (next.has(workspaceId)) next.delete(workspaceId)
              else next.add(workspaceId)
              collapsed.set(next)
            }}

            runningThreadIds={runningIds}
          />

          <ConfirmationDialog
            confirmLabel="删除项目"
            description={
              removing === null
                ? ''
                : `「${removing.name}」会从侧栏移除，其中的对话会一起删除。磁盘上的文件夹不会被删除。`
            }
            destructive
            onCancel={() => {
              setRemoving(null)
            }}
            onConfirm={() => {
              const target = removing
              setRemoving(null)
              if (target === null) return
              /* 当前页若属于这个项目，先回入口页：不要停在一个即将不存在的对话上。 */
              const current = active === null ? undefined : stores.threads.byId(active)
              if (current?.workspaceId === target.id) newThread()
              void workspaces.remove(target.id)
            }}
            open={removing !== null}
            title="删除项目？"
          />

          {/*
                归档横幅。撤销走
                setArchived(false)，与「已归档」页的「取消归档」是同一条契约方法。
            */}
          {archivedNotice === null ? null : (
            <Banner
              actions={[
                {
                  label: '撤销',
                  onClick: () => {
                    const threadId = archivedNotice.threadId
                    archived.set(null)
                    void api
                      .setArchived(threadId, false)
                      .then((t) => stores.threads.upsert(t))
                      .catch(failed('unarchive', threadId))
                  },
                },
                { label: '筛选已归档会话', onClick: showArchived, prefix: '或' },
              ]}
              key={`archived-${String(archivedNotice.seq)}`}
              onDone={() => {
                archived.set(null)
              }}
              text="会话已归档，可"
              tone="success"
            />
          )}
        </>
      )
    },
  })

  /* 会话页右上角的两枚开关：任务开关钉在主区右缘、辅助开关钉在窗口右缘，进入对话页才画。定位由外壳的包装层负责，组件只画按钮本体。 */
  ctx.contribute(builtinPoints.mainControls, {
    id: 'conversation.todo',
    order: 10,
    slot: 'main',
    component: () => <ConversationTodoToggle todoThread={todoThread} />,
  })
  ctx.contribute(builtinPoints.mainControls, {
    id: 'conversation.auxiliary',
    order: 20,
    slot: 'window',
    component: () => <ConversationAuxiliaryToggle layout={layout} />,
  })

  /*
   * 入口表面：这一格在发出第一句话之前**还没有线程**，所以线程是懒建的 —— `prepare` 里 createThread，拿到号之后才把端口交给表面。
   * 这是两个路由，所以这里建完号就导航过去。
   */
  ctx.contribute(builtinPoints.surfaces, {
    id: 'conversation.home',
    title: '新对话',
    component: () => {
      useEffect(prefetchProse, [])
      return (
        <ConversationProviders posture={posture} transcripts={transcripts}>
          <HomeSurface
            api={api}
            entryDefaults={entryDefaults}
            preferences={prefs}
            onOpenThread={openThread}
            onStartCommand={startCommand}
            posture={posture}
            sessions={sessions}
            stores={stores}
            workspaces={workspaces}
          />
        </ConversationProviders>
      )
    },
  })
  ctx.contribute(builtinPoints.surfaces, {
    id: 'conversation.thread',
    title: '对话',
    /* 右坞按对话分账：每条对话自己记开没开、开着哪几格。入口页（还没有线程）不写 dockOwner，那里不画右坞。 */
    dockOwner: (params) => (params.threadId === undefined || params.threadId === '' ? null : params.threadId),
    component: ({ params }: { readonly params: Readonly<Record<string, string>> }) => {
      const threadId = String(params.threadId ?? '')
      useEffect(prefetchProse, [])
      /*
       * 控件表、线程行、项目名单都要**订阅**着读。原先三样都读 `getState()`：那是一次性快照，
       * 而这些数据都要等一次往返才到，首帧拿到空值且不会重画 —— 屏幕上是「输入框那一排选择器不显示 / 项目名要切一次页面才出现」（真实故障）。
       */
      const controls = useFeatureStore(stores.controls.store, (s) => s.byThread[threadId]) ?? null
      const controlsFailure = useFeatureStore(stores.controls.store, (s) => s.failure[threadId])
      /* 用量那一格单独订阅：它每轮都换，而控件表不换。 */
      const pushedUsage = useFeatureStore(stores.controls.store, (s) => s.usage[threadId])
      /*
       * `receivedAt` 取这一次快照到手的时刻（面板的秒针从它推），引用必须**跟着快照走** —— 每帧换一个对象会让 memo 过的 AssistantSurface 整棵重画。
       */
      const goalSnapshot = useFeatureStore(stores.controls.store, (s) => s.byThread[threadId]?.goalSnapshot)
      const goal = useMemo(() => sessionGoalOf(goalSnapshot, Date.now()), [goalSnapshot])
      /* 设置页关掉的模型订阅着读：开关一拨，输入框的模型菜单当场跟着变，不等重开会话或重启。 */
      const hiddenModels = hiddenModelsOf(useObservable(prefs))
      const shownControls = useMemo(
        () => withoutHiddenModels(sessionConfigControlsOf(controls), hiddenModels),
        [controls, hiddenModels],
      )
      /* 世界线记录本身：贡献点（review 的改动数、usage 的累计用量）收的就是它。 */
      const thread = useFeatureStore(stores.threads.store, (s) => s.items.find((t) => t.id === threadId))
      const view = useWorkspacesView(workspaces)
      /*
       * 会话端口从注册表取（**不要在这里新建**）：注册表按对话号持有身份，所以「同一条对话永远是同一根端口」在重挂载、
       * StrictMode 双渲染、切走再切回来这几条路上都成立。组件里 `useMemo` 做不到 —— 它随组件生命周期生灭，换个实例就换一根端口。
       */ const session = threadId === '' ? undefined : sessions.port(threadId)
      /* 看不开、写才开（性能方案 P4）：挂载只问控件表，人开始写时 engage 预热，卸载释放；规则与 StrictMode 的兜底在 thread-lifecycle.ts 里。 */
      const engage = useThreadSessionLifecycle({
        threadId,
        open: api.openThread,
        close: api.closeThread,
        refreshControls,
      })
      /* omp 的斜杠命令：表随会话现算，输出不进会话文件，所以由这一层按对话号收着 */
      const commands = useThreadCommands(api, threadId, takePendingCommand)
      /* 表面实例跨对话复用：按对话号记着取到的那一句，换了对话就重取，不把上一条的话放进这一条 */
      const [held, setHeld] = useState(() => ({ threadId, text: prefills.get(threadId) }))
      if (held.threadId !== threadId) setHeld({ threadId, text: prefills.get(threadId) })
      useEffect(() => {
        prefills.delete(threadId)
      }, [threadId])
      /* 点子代理（工具卡上的通道、状态面板的「智能体」行）= 在右坞开它的标签：引用跟着对话号走，不让 Context 每帧换值。 */
      const openDelegateChannel = useMemo(
        () => (agentId: string, title?: string) => openSubagentTab(layout, subagentTabs, threadId, agentId, title),
        [threadId],
      )
      return (
        <ConversationProviders
          agentControls={api}
          fileScope={{ threadId, workspaceId: thread?.workspaceId ?? null }}
          liveComposers={liveComposers}
          onOpenDelegateChannel={openDelegateChannel}
          posture={posture}
          transcripts={transcripts}
        >
          <AssistantSurface
            {...(session === undefined ? {} : { session })}
            commands={commands}
            controls={shownControls}
            controlsFailure={controlsFailure}
            endpoint={threadId}
            goal={goal}
            isNew={false}
            onComposeIntent={engage}
            onFork={(keepTurns) => {
              void api
                .forkThread({ threadId, keepTurns })
                .then((t) => {
                  stores.threads.upsert(t)
                  openThread(t.id)
                })
                .catch(failed('fork', threadId))
            }}
            onRewrite={(turn) => rewriteThread(threadId, turn)}
            prefill={held.threadId === threadId ? held.text : undefined}
            onGoalAction={(action) => runGoalAction(api, threadId, action)}
            onExportThread={(id) => void exportThread(id)}
            onShareThread={(id) => void shareThread(id)}
            onPinThread={(id, pinned) => {
              void api
                .setPinned(id, pinned)
                .then((t) => stores.threads.upsert(t))
                .catch(failed('pin', id))
            }}
            onRenameThread={(id, title) => {
              void api
                .renameThread(id, title)
                .then((t) => stores.threads.upsert(t))
                .catch(failed('rename', id))
            }}
            onSelectControl={(controlId, value) => {
              if (controlId === 'model') {
                const at = value.indexOf('/')
                if (at > 0) {
                  void api
                    .setModel(threadId, { provider: value.slice(0, at), id: value.slice(at + 1) })
                    .catch(failed('setModel', threadId))
                }
                return
              }
              if (controlId === 'thought') void api.setThinking(threadId, value).catch(failed('setThinking', threadId))
              if (controlId === PLAN_CONTROL_ID) {
                void api.setPlanMode(threadId, value === PLAN_ENABLED).catch(failed('setPlanMode', threadId))
              }
              /*
               * **打开**那一档走「发送时生效」（正文就是 objective，只有发送那一步拿得到）；**关掉**必须当场生效 ——
               * 人点的是「不收这个目标了」，等下一句才收等于开关失灵。暂停 / 继续 / 改正文走 onGoalAction（R-10）。
               */
              if (controlId === GOAL_CONTROL_ID) {
                if (value === GOAL_DISABLED) void runGoalAction(api, threadId, { kind: 'clear' })
                return
              }
              if (controlId === 'permission') {
                /* 选的是**产品值**（manual / yolo / auto），发回引擎的必须是它那一档（ask / auto-edit / full-access），直接下发会被 Core 拒掉。映射表在 control-shapes.ts。 */
                const posture = postureOfControl(value)
                if (posture !== undefined) void api.setPosture(threadId, posture).catch(failed('setPosture', threadId))
              }
            }}
            thread={thread}
            todoThread={todoThread}
            usage={effectiveUsage(pushedUsage, controls)}
            workspace={{
              choices: view.items.map((w) => ({ id: w.id, name: w.name })),
              current: view.active,
              onBrowse: () => void workspaces.pickAndAdd(),
              onChoose: (workspaceId) => workspaces.setActive(workspaceId),
            }}
          />
        </ConversationProviders>
      )
    },
  })

  /* 设置里的「已归档」页，数据是会话自己的归档列表。段内 order 710 照既有的相对次序（用量 700 → 已归档 → 存储 900）。 */
  ctx.contribute(builtinPoints.settingsPages, {
    id: 'conversation.archived',
    group: SETTINGS_GROUPS.agent,
    order: 710,
    title: '已归档',
    icon: Archive,
    component: () => <ArchivedChatsPage api={api} logger={ctx.logger} threads={stores.threads} />,
  })
}

/** 第 `turn` 轮开场那句话的原文（技能与附件记号不带回：omp `/branch` 也只回填文字） */
function promptOfTurn(timeline: TimelineState, turn: number): string {
  const page = [...timeline.sealed, timeline.active].find((candidate) => candidate.turn === turn)
  const said = page?.items.find((item) => item.type === 'user_message')
  return said?.type === 'user_message' ? said.text : ''
}
