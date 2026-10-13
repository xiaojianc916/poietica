import { Banner } from '@poietica/design-system'
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
import { useMemo } from 'react'
import { ActiveOwner } from '../components/active-owner'
import { AssistantSurface } from '../components/assistant-surface'
import { ConversationAuxiliaryToggle, ConversationTodoToggle } from '../components/conversation-controls'
import { GOAL_CONTROL_ID, GOAL_DISABLED } from '../components/goal/goal-control'
import { HomeSurface } from '../components/home-surface'
import { NewConversationNavRow } from '../components/new-conversation-nav-row'
import { AssistantThreadList } from '../components/threads/assistant-thread-list'
import { ConversationProviders } from '../composition'
import {
  effectiveUsage,
  PLAN_CONTROL_ID,
  PLAN_ENABLED,
  postureOfControl,
  sessionConfigControlsOf,
  sessionGoalOf,
} from '../configuration/control-shapes'
import { runGoalAction } from '../goal-actions'
import { ArchivedChatsPage } from '../settings/archived-page'
import { useThreadSessionLifecycle } from '../threads/thread-lifecycle'
import { groupByWorkspace } from '../threads/thread-order'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'
import { useRunningThreadIds } from './use-running-thread-ids'

/** 界面、侧栏、面板等贡献。 */
export function createConversationContributions(setup: ConversationSetup, actions: ConversationActions): void {
  const { api, ctx, layout, posture, sessions, stores, transcripts, workspaces } = setup
  const { archived, collapsed, exportThread, newThread, openThread, showArchived, todoThread } = actions

  /*
   * ── 侧栏导航：新建对话 ───────────────────────────────────────────────────
   *
   * legacy 的侧栏顶行由外壳写死（SidebarNav 的 'ai' 那一枚，icon SquarePen、
   * title 「新建对话」），因为它属于「打开 AI 入口」这个动作而不属于任何一个表面。
   * 新架构里它归 conversation —— 这个功能才知道入口在哪儿，外壳一个产品常量都不写。
   */
  ctx.contribute(builtinPoints.sidebarSections, {
    id: 'conversation.new',
    order: 5,
    title: '新建对话',
    icon: SquarePen,
    placement: 'nav',
    component: () => <NewConversationNavRow />,
  })

  // ── 侧栏：线程列表（legacy 的 AssistantThreadList，数据换成契约）─────────
  ctx.contribute(builtinPoints.sidebarSections, {
    id: 'conversation.threads',
    order: 20,
    title: '项目',
    component: () => {
      /*
       * 必须**订阅**着读。原先写的是 getState()，那是一次性快照：组件在 store 还空着
       * （isLoading=true）时渲染一遍就再也不会重画，侧栏因此永远停在骨架屏上。
       *
       * 两条判据缺一不可（与上面 useRunningThreadIds 同一条）：
       *   1. 必须订阅着读 —— 否则首帧之后就再也不重画；
       *   2. 选择器必须交回**稳定引用** —— `s.items.map(...)` 每次都造一个新的行数组，
       *      而 useShallow 比的是**数组元素**：元素是每帧新建的对象，`Object.is` 永远
       *      判「变了」，React 会一路重渲染到自己喊 "Maximum update depth exceeded"
       *      （真机实测：一条线程都没有时看不出来，发出第一句话、列表长出第一行之后
       *      整个侧栏那一段当场被错误边界接管）。所以这里选 `s.items` 本身（store 换
       *      数组才换引用），行的形状在外层用 useMemo 派生。
       */
      const threads = useFeatureStore(stores.threads.store, (s) => s.items)
      const items = useMemo(
        () =>
          threads
            /*
             * 已归档的对话**移出活动列表**（契约里 archived 就是这件事的记号）：store 留着
             * 整条记录（线程页 / 命令要按 id 查得到它），侧栏这一格只画活动的。原先不过滤，
             * 归档之后那一行照画 —— 用户看到的就是「点了归档没反应」。
             */
            .filter((thread) => !thread.archived)
            .map((thread) => ({
              id: thread.id,
              title: thread.title,
              isPinned: thread.pinned,
              updatedAt: new Date(thread.updatedAt).toISOString(),
              workspaceId: thread.workspaceId,
              record: thread,
            })),
        [threads],
      )
      const state = useFeatureStoreShallow(stores.threads.store, (s) => ({
        isLoading: s.isLoading,
        failure: s.failure,
      }))
      /*
       * 项目名单与运行中标记同样**订阅**着读：两者都要等一次往返才有值，读快照的话
       * 那一次渲染之后就再也不会重画（组头空着、运行标记停在首帧）。
       */
      const view = useWorkspacesView(workspaces)
      const runningIds = useRunningThreadIds(stores.turnStates)
      /*
       * 高亮**直接从路由读**，不经过任何手写订阅。
       *
       * 判据只有一条：停在线程页才有当前线程，入口页 / 设置页一律 null（入口页没有
       * 「当前会话」，上一次打开的那条不该继续亮着）。直接从导航读，就不存在「某条
       * 跳转路径没触发通知」导致的残留 —— 这才是侧栏高亮反复修不好的真原因。
       *
       * 折叠同样**订阅**着读：它是一份可订阅值，读快照的话点文件夹组头没有任何反应。
       */
      const { route } = useNavigation()
      const active = route.surface === 'conversation.thread' ? (route.params.threadId ?? null) : null
      const collapsedWorkspaces = useObservable(collapsed)
      /* 归档横幅同样订阅着读：读到快照的话 set 之后这一格不会重画（与折叠同一条）。 */
      const archivedNotice = useObservable(archived)
      /*
       * 组名从工作区表里查：新架构的 thread.workspaceId 是工作区实体 id，不是路径，
       * 所以组头不能用「路径末段」那套去猜（会得到一个 uuid 或者 null）。这一条
       * 与 legacy 的分组形状一致，换的只是名字的来源。
       */
      const grouped = groupByWorkspace(items, (workspaceId) => {
        const workspace = view.items.find((w) => w.id === workspaceId)
        return workspace?.name ?? null
      })
      return (
        <>
          <AssistantThreadList
            activeThreadId={active}
            collapsedWorkspaces={collapsedWorkspaces}
            failure={state.failure}
            groups={grouped}
            isLoading={state.isLoading}
            onActivate={openThread}
            onArchive={(threadId) => {
              void api.setArchived(threadId, true).then((t) => {
                stores.threads.upsert(t)
                archived.set({ threadId, seq: (archived.current()?.seq ?? 0) + 1 })
              })
            }}
            onCreate={newThread}
            onPin={(threadId, pinned) => {
              void api.setPinned(threadId, pinned).then((t) => stores.threads.upsert(t))
            }}
            onToggleWorkspace={(workspaceId) => {
              /* 换一份新 Set 再 set：可订阅值按引用判变化，就地 mutate 不会通知任何人。 */
              const next = new Set(collapsed.current())
              if (next.has(workspaceId)) next.delete(workspaceId)
              else next.add(workspaceId)
              collapsed.set(next)
            }}
            runningThreadIds={runningIds}
          />

          {/*
                归档横幅（legacy assistant-sidebar-panel 的两条动作一字未改）。撤销走
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
                    void api.setArchived(threadId, false).then((t) => stores.threads.upsert(t))
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

  /*
   * ── 会话页右上角的两枚开关 ──────────────────────────────────────────────
   *
   * legacy 的 workspace.tsx 把 ConversationControls 交给外壳的 `main.controls` 格位：
   * 任务开关钉在主区右缘、辅助开关钉在窗口右缘（workspace-shell.css 里那两条栅格
   * 规则），进入对话页才画。新架构里这条格子是 `builtinPoints.mainControls`（外壳不
   * 认识任何功能），定位仍由外壳的包装层负责，组件只画按钮本体。
   */
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

  // ── 表面：新对话入口与会话页（legacy 的 AssistantSurface，两个相位）───────
  /*
   * 入口表面：这一格在发出第一句话之前**还没有线程**，所以线程是懒建的 ——
   * \`prepare\` 里 createThread，拿到号之后才把会话端口交给表面（端口按线程建）。
   * legacy 是同一个形状：entry 相位的 \`prepare\` 把铸好的号写进平台，随后同一个组件
   * 转入 live 相位。新架构把它拆成两个路由，所以这里建完号就导航过去（onUserMessage）。
   */
  ctx.contribute(builtinPoints.surfaces, {
    id: 'conversation.home',
    title: '新对话',
    component: () => (
      <ConversationProviders posture={posture} transcripts={transcripts}>
        <ActiveOwner layout={layout} owner={null} />
        <HomeSurface
          api={api}
          onOpenThread={openThread}
          posture={posture}
          sessions={sessions}
          stores={stores}
          workspaces={workspaces}
        />
      </ConversationProviders>
    ),
  })
  ctx.contribute(builtinPoints.surfaces, {
    id: 'conversation.thread',
    title: '对话',
    component: ({ params }: { readonly params: Readonly<Record<string, string>> }) => {
      const threadId = String(params.threadId ?? '')
      /*
       * 控件表、线程行、项目名单都要**订阅**着读。
       *
       * 原先三样都读 `getState()`／普通取值：那是一次性快照。这些数据都要等一次往返
       * 才到（controls 在 openThread 之后才回来、线程行等线程列表刷新），首帧拿到的是
       * 空值，而空值不会因为后来的数据到达而重画 —— 屏幕上就是「输入框那一排选择器
       * 不显示 / 项目名要切一次页面才出现」（真实故障）。
       */
      const controls = useFeatureStore(stores.controls.store, (s) => s.byThread[threadId]) ?? null
      const controlsFailure = useFeatureStore(stores.controls.store, (s) => s.failure[threadId])
      /* 用量那一格单独订阅：它每轮都换，而控件表不换 —— 分成两格才不会互相拖着重画。 */
      const pushedUsage = useFeatureStore(stores.controls.store, (s) => s.usage[threadId])
      /*
       * 目标面板那一份。`receivedAt` 取这一次快照到手的时刻：面板的秒针从它推，
       * 引用必须**跟着快照走**而不是每帧新造 —— 每帧换一个对象会让 memo 过的
       * AssistantSurface 整棵重画（与 usage 那一格同一条理由）。
       */
      const goalSnapshot = useFeatureStore(stores.controls.store, (s) => s.byThread[threadId]?.goalSnapshot)
      const goal = useMemo(() => sessionGoalOf(goalSnapshot, Date.now()), [goalSnapshot])
      /* 世界线记录本身：贡献点（review 的改动数、usage 的累计用量）收的就是它。 */
      const thread = useFeatureStore(stores.threads.store, (s) => s.items.find((t) => t.id === threadId))
      const view = useWorkspacesView(workspaces)
      /*
       * 会话端口：从注册表取（**不要在这里新建**）。注册表按对话号持有身份，
       * 所以「同一条对话永远是同一根端口」这件事实在下面这几条路上都成立 ——
       * 重挂载、StrictMode 的双渲染、切走再切回来。组件里 `useMemo` 做不到这一条：
       * 它随组件生命周期生灭，换个实例就换一根端口，下游按身份判的那几条会失效。
       */
      const session = threadId === '' ? undefined : sessions.port(threadId)
      /*
       * 挂载预热 / 卸载释放（07 页 §5E 的 surfaces 一行：挂载时 threads.open，卸载时 threads.close）。
       * 规则与 StrictMode 的兜底在 thread-lifecycle.ts 里，这里只把它接上。
       */
      useThreadSessionLifecycle({ threadId, open: api.openThread, close: api.closeThread })
      return (
        <ConversationProviders posture={posture} transcripts={transcripts}>
          <ActiveOwner layout={layout} owner={threadId} />
          <AssistantSurface
            {...(session === undefined ? {} : { session })}
            controls={sessionConfigControlsOf(controls)}
            controlsFailure={controlsFailure}
            endpoint={threadId}
            goal={goal}
            isNew={false}
            onFork={(dropTurns) => {
              void api.forkThread({ threadId, undoTurns: dropTurns }).then((t) => {
                stores.threads.upsert(t)
                openThread(t.id)
              })
            }}
            onGoalAction={(action) => runGoalAction(api, threadId, action)}
            onExportThread={(id) => void exportThread(id)}
            onPinThread={(id, pinned) => {
              void api.setPinned(id, pinned).then((t) => stores.threads.upsert(t))
            }}
            onRenameThread={(id, title) => {
              void api.renameThread(id, title).then((t) => stores.threads.upsert(t))
            }}
            onSelectControl={(controlId, value) => {
              if (controlId === 'model') {
                const at = value.indexOf('/')
                if (at > 0) void api.setModel(threadId, { provider: value.slice(0, at), id: value.slice(at + 1) })
                return
              }
              if (controlId === 'thought') void api.setThinking(threadId, value)
              /* 计划：点了就立刻下发给会话（07 页 §5E）。 */
              if (controlId === PLAN_CONTROL_ID) void api.setPlanMode(threadId, value === PLAN_ENABLED)
              /*
               * 目标（输入框下方那颗开关）：**打开**那一档走「发送时生效」（正文就是 objective，
               * 只有发送那一步拿得到，面板往草稿写一格待提交的配置，见 session-port 的 prompt）；
               * **关掉**必须当场生效 —— 人点的是「不收这个目标了」，等下一句才收等于开关失灵。
               * 暂停 / 继续 / 改正文不走这里：它们是目标栏与任务浮层的动作，走 onGoalAction（审查 R-10）。
               */
              if (controlId === GOAL_CONTROL_ID) {
                if (value === GOAL_DISABLED) void runGoalAction(api, threadId, { kind: 'clear' })
                return
              }
              if (controlId === 'permission') {
                /*
                 * 胶囊上选的是**产品值**（manual / yolo / auto），发回引擎的必须是它那一档
                 * （ask / auto-edit / full-access）—— 直接下发会让 Core 拒掉（那三个值不在
                 * Posture 里）。映射表在 control-shapes.ts，与正向换算共用一张。
                 */
                const posture = postureOfControl(value)
                if (posture !== undefined) void api.setPosture(threadId, posture)
              }
            }}
            thread={thread}
            todoThread={todoThread}
            usage={effectiveUsage(pushedUsage, controls)}
            workspace={{
              choices: view.items.map((w) => ({ id: w.id, name: w.name })),
              current: view.active,
              onBrowse: () => void workspaces.pickAndAdd(),
              /* 选择器交回的是工作区 id（见 home-surface.tsx 同名回调的头注）。 */
              onChoose: (workspaceId) => workspaces.setActive(workspaceId),
              onClear: () => void workspaces.createScratch(),
            }}
          />
        </ConversationProviders>
      )
    },
  })

  /*
   * 设置里的「已归档」页（图三的中段最后一格）。legacy 的这一页在
   * `packages/settings/src/ui/surface/archived-chats-settings.tsx`，数据是会话自己的
   * 归档列表 —— 新架构里它归 conversation（它才是线程数据的持有者）。
   * 07 页的功能设计没有给这一页落点（方案缺口），按产品负责人 2026-10-07 的指示补在这里；
   * 段内 order 710 照 legacy 的相对次序（… 用量 700 → 已归档 → 存储 900）。
   */
  ctx.contribute(builtinPoints.settingsPages, {
    id: 'conversation.archived',
    group: SETTINGS_GROUPS.agent,
    order: 710,
    title: '已归档',
    icon: Archive,
    component: () => <ArchivedChatsPage api={api} threads={stores.threads} />,
  })
}
