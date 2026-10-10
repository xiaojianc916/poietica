/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { Banner } from '@poietica/design-system'
import { platformContract } from '@poietica/feature-platform/contract'
import { type WindowCloseGuard, WindowCloseToken } from '@poietica/feature-platform/ui-api'
import { preferencesContract } from '@poietica/feature-preferences/contract'
import { PreferencesToken } from '@poietica/feature-preferences/ui-api'
import { useWorkspacesView, type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import type { Disposable } from '@poietica/foundation'
import {
  builtinPoints,
  type CommandItem,
  createValue,
  type DialogService,
  DialogsToken,
  defineUiFeature,
  type LayoutService,
  LayoutToken,
  type NavigationService,
  NavigationToken,
  SETTINGS_GROUPS,
  ToastsToken,
  useFeatureStore,
  useFeatureStoreShallow,
  useNavigation,
  useObservable,
  useService,
} from '@poietica/ui-kernel'
import { Archive, FileText, MessageSquareText, SquarePen } from 'lucide-react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { ConversationUiToken, SkillDocumentToken } from '../ui-api'
import { createConversationApi } from './api'
import { AssistantSurface } from './components/assistant-surface'
import { AuxiliaryComposer } from './components/composer/auxiliary-composer'
import {
  ConversationAuxiliaryToggle,
  type ConversationTodoThread,
  ConversationTodoToggle,
} from './components/conversation-controls'
import { GOAL_CONTROL_ID, GOAL_DISABLED } from './components/goal/goal-control'
import { HomeSurface } from './components/home-surface'
import { SkillDocumentPane } from './components/skill-document-pane'
import { createSkillDocumentStore, SKILL_DOCUMENT_PANEL, toggleSkillDocument } from './components/skill-document-store'
import { AssistantThreadList } from './components/threads/assistant-thread-list'
import { ConversationProviders } from './composition'
import { createPostureIntent } from './configuration/posture-intent'
import {
  effectiveUsage,
  PLAN_CONTROL_ID,
  PLAN_ENABLED,
  postureOfControl,
  sessionConfigControlsOf,
  sessionGoalOf,
} from './control-shapes'
import { runGoalAction } from './goal-actions'
import { ArchivedChatsPage } from './settings/archived-page'
import { type ConversationStores, createDraftPin, createStores, type TurnStatesStore } from './stores'
import { completionBody, confirmDeleteThread, confirmQuit, isTurnSettled, shouldNotify } from './stores/notify'
import { createSessionRegistry } from './stores/session-registry'
import { useThreadSessionLifecycle } from './thread-lifecycle'
import { groupByWorkspace } from './threads/thread-order'
import { TranscriptStore } from './transcript/transcript-store'

/* ── 新架构的数据 → legacy 组件要的形状 ──────────────────────────────────────
 *
 * 换算函数住在 control-shapes.ts 而不是本文件：ui/components/home-surface.tsx 也要用它，
 * 而那个组件若从本文件（ui/index.tsx）取，depcruise 的 no-circular 会判
 * index → home-surface → index 成环（真实违规）。本文件只管装配。
 */

/*
 * 运行中的线程标记（侧栏那一圈转动的标记）。这是**组件里**读它的唯一入口。
 *
 * 两条判据缺一不可：
 *   1. 必须订阅着读 —— turnStates 由 turns.state 通知逐条写入，读快照的话那圈标记
 *      只停在首帧那一次（多半一条都还没有）；
 *   2. 选择器必须交回**稳定引用**：这里选的是 byThread 这个对象本身（Object.is 比得动），
 *      集合在外层派生。把 `new Set(...)` 写进选择器，useShallow 比的是集合引用，
 *      永远判成「变了」，组件会一路重渲染到 "Maximum update depth exceeded"
 *      （真实故障；内核在 useFeatureStoreShallow 的头注里警告过同一件事）。
 */
function useRunningThreadIds(store: TurnStatesStore): ReadonlySet<string> {
  const byThread = useFeatureStore(store.store, (s) => s.byThread)
  return useMemo(
    () =>
      new Set(
        Object.values(byThread)
          .filter((s) => s.state !== 'idle')
          .map((s) => s.threadId),
      ),
    [byThread],
  )
}

export default defineUiFeature({
  id: 'conversation',
  dependsOn: ['workspaces', 'preferences', 'platform'],
  setup(ctx) {
    const api = createConversationApi(ctx)
    const platform = ctx.rpc(platformContract)
    /*
     * 批准方式的持久意图：写在 preferences 功能的 uiState 里（`conversation.permissionPosture`，
     * 契约里已登记的键）。conversation 的 `dependsOn` 本来就含 'preferences'，所以这条契约
     * 调用合法（03 页 §2.2 的分层：功能间只经 contract 协作）。
     */
    const preferences = ctx.rpc(preferencesContract)
    const posture = createPostureIntent({
      read: () => preferences.call('uiState.get', { key: 'conversation.permissionPosture' }).then((r) => r.value),
      write: (value) =>
        preferences.call('uiState.set', { key: 'conversation.permissionPosture', value }).then(() => undefined),
      report: (cause) => {
        ctx.logger.warn('permission posture memory failed', { error: String(cause) })
      },
    })
    const navigation = ctx.services.get(NavigationToken) as NavigationService
    const dialogs = ctx.services.get(DialogsToken) as DialogService
    const toasts = ctx.services.get(ToastsToken)
    const prefs = ctx.services.get(PreferencesToken)
    const workspaces = ctx.services.get(WorkspacesUiToken) as WorkspacesUi

    const stores: ConversationStores = createStores(api)

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
     * 会话端口的注册表：**端口的身份只在这里管**（stores/session-registry.ts 的头注）。
     *
     * 转录 store 需要「把对话号变成一根端口」这个能力，但它不 import 自己的 api ——
     * 与 TranscriptSink 同一条理由，这里把工厂函数交给它，装配留在装配层。
     */
    /*
     * 转录 store：legacy 的那一个（副本、队列、待答都在里面），
     * 数据来源由 ui/stores/session-port.ts 接到 RPC 上。它经 Context 交给组件树，
     * 与 legacy 的接线方式一致（components/transcript/transcripts-context.ts 的头注）。
     */
    let sessions: ReturnType<typeof createSessionRegistry>
    const transcripts = new TranscriptStore({ sessions: (threadId) => sessions.port(threadId) })
    /*
     * 会话端口的注册表：**端口的身份只在这里管**（stores/session-registry.ts 的头注）。
     *
     * 快照里的「提交行」也从这里转给转录 store（「Core 即时回显」方案第 5 节：三个来源
     * 之一是订阅快照）。回调写成经 transcripts 转发，所以两台要按这个顺序建。
     */
    sessions = createSessionRegistry({
      api,
      onSubmissions: (threadId, rows) => {
        for (const row of rows) transcripts.upsertSubmission(threadId, row)
      },
    })
    /* 右栏「技能文档」看的那一份（见 components/skill-document-store.ts 的头注）。 */
    const skillDocuments = createSkillDocumentStore()
    const layout = ctx.services.get(LayoutToken) as LayoutService
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

    // ── 订阅：所有增量都进各自的副本（UI 自己按 threadId 过滤）───────────────
    ctx.lifecycle.onDispose(
      api.onTimelineOps((p) => {
        /*
         * 时间线的增量由端口层（stores/session-port.ts）翻译成副本信号；这里只剩
         * 「真实那一轮到达 → 提交行销账」这一条与转录无关的副作用。
         */
        const stamped = p.ops.flatMap((op) => {
          const turn = (op as { op: string; turn?: { clientTurnId?: string } }).turn
          return op.op === 'turn.upsert' && turn?.clientTurnId !== undefined ? [turn.clientTurnId] : []
        })
        if (stamped.length > 0) {
          /* 待发提交表在真实那一轮到达时销账：提交行换成真实 turn。 */
          transcripts.settleSubmissions(p.threadId, stamped)
        }
      }).dispose,
    )
    /* 「Core 即时回显」的两条通知：提交行的存续与消失都由 Core 说了算。 */
    ctx.lifecycle.onDispose(
      api.onSubmissionChanged((p) => {
        transcripts.upsertSubmission(p.threadId, p.submission)
      }).dispose,
    )
    ctx.lifecycle.onDispose(
      api.onSubmissionRemoved((p) => {
        transcripts.removeSubmission(p.threadId, p.clientTurnId)
      }).dispose,
    )
    ctx.lifecycle.onDispose(api.onThreadUpdated((t) => stores.threads.upsert(t)).dispose)
    ctx.lifecycle.onDispose(
      api.onThreadRemoved((p) => {
        stores.threads.remove(p.threadId)
        stores.turnStates.clear(p.threadId)
        /*
         * 时间线副本与端口注册表都要跟着这条对话一起收掉。
         *
         * 两者各管一半（store 退订阅、注册表丢对象），所以必须从同一个入口发起；
         * 少发一处就是「一边忘了一边还记得」的半状态 —— 端口留着，后来同一个 id
         * 的新对话会读到上一份订阅计数。
         */
        transcripts.forget(p.threadId)
        sessions.release(p.threadId)
      }).dispose,
    )
    /*
     * 一轮结束 → 系统通知（07 页 §5E / CV-10 的同一条路）。
     *
     * 「结束」= turns.state 从 running / awaiting 回到 idle。判据用**前一份状态**：
     * 只看当前是 idle 会把 threads.list 的初始快照也当成一次「结束」，一打开软件就弹。
     * 这一格里 `document.hasFocus()` 与偏好由 notify() 统一判，测试只验这条规则。
     */
    ctx.lifecycle.onDispose(
      api.onTurnState((s) => {
        const previous = stores.turnStates.get(s.threadId)?.state
        stores.turnStates.set(s)
        if (isTurnSettled(previous, s.state)) notify(s.threadId, completionBody(s.error), 'completion')
      }).dispose,
    )
    ctx.lifecycle.onDispose(api.onControlsChanged((p) => stores.controls.set(p.threadId, p.controls)).dispose)
    /*
     * 上下文用量单独一条（契约里 controls.contextChanged 的头注说明为什么不合进 controls.changed）：
     * 它每轮都在变，而控件表只在模型 / 档位 / 模式变了才变。
     */
    ctx.lifecycle.onDispose(api.onContextUsage((p) => stores.controls.setUsage(p.threadId, p.usage)).dispose)
    /*
     * 需要确认的通知只发一次系统通知 —— 待答卡片本身来自时间线的 interactions 表
     * （转录副本订阅的那条路），这里不再另存一份。
     */
    ctx.lifecycle.onDispose(
      api.onInteractionRequested((p) => {
        notify(p.threadId, '需要你的确认', 'needs-confirm')
      }).dispose,
    )

    /*
     * 点系统通知 → 回到那条对话（07 页 §5E 通知表最后一行）。
     *
     * threadId 为 null 时（例如别的功能发的没有归属的通知）什么都不做：没有目标就不跳，
     * 跳到「一个新对话」会是凭空多出来的行为。
     */
    ctx.lifecycle.onDispose(
      platform.on('notify.clicked', ({ threadId }) => {
        if (threadId === null || threadId === '') return
        openThread(threadId)
      }).dispose,
    )

    // ── core ready / lost：整体重新同步（14 页 §9.5f、R-04 §3.7）────────────
    ctx.lifecycle.onDispose(() => {
      transcripts.dispose()
    })

    /*
     * Core 换代：运行态与已绑定对话全部不可信。
     *
     * 只做同步的内存清理（这是 onCoreLost 的硬要求：此刻 Core 不可用，RPC 会排队到超时）；
     * 真正重读放在随后的 onCoreReady 里。
     */
    ctx.lifecycle.onCoreLost(() => {
      stores.turnStates.resetAll()
      transcripts.markAllStale()
    })

    /*
     * 草稿读盘**只做一次**。
     *
     * `hydrate` 是 `{...当前, ...盘上}` 的合并：Core 每次重启都重读一遍，会把重启那一刻
     * 输入框里最近 300ms（UI 去抖）+ 500ms（Host 去抖）内敲的字用盘上的旧版本盖回去
     * （R-04 §1.5）。`posture.load()` 与它同一条理由。
     */
    /*
     * 「读失败」与「盘上没有值」必须分开（R-07 §3.4）：前者要保持「草稿没恢复」，
     * 下一次 ready 再读；混在一起会让 attachments 那一侧在一个空集合上做整体替换，
     * 把盘上草稿的引用全清掉。读成功（哪怕是 null）才算恢复完成。
     */
    const loadDraftsOnce = async (): Promise<void> => {
      let storedDrafts: unknown
      try {
        storedDrafts = (await preferences.call('uiState.get', { key: 'conversation.drafts' })).value
      } catch (cause) {
        ctx.logger.warn('drafts load failed', { error: String(cause) })
        return
      }
      if (storedDrafts !== null && typeof storedDrafts === 'object') {
        stores.composer.hydrate(storedDrafts as Record<string, import('./stores/composer').Draft>)
      }
      draftPin.markRestored()
    }

    let readyCount = 0
    ctx.lifecycle.onCoreReady(async () => {
      readyCount += 1
      const first = readyCount === 1
      const steps: Array<readonly [string, () => unknown]> = [
        ['threads', () => stores.threads.refresh()],
        ...(first ? ([['posture', () => posture.load()]] as const) : []),
        /* 读失败时保持「没恢复」，所以不是「只有第一次」——恢复到之前每次 ready 都试。 */
        ...(draftPin.restored() ? [] : ([['drafts', () => loadDraftsOnce()]] as const)),
        [
          'transcripts',
          () => {
            for (const threadId of transcripts.resyncVisible()) {
              void stores.controls.refresh(threadId)
            }
          },
        ],
      ]
      /*
       * 每一步各自兜底：某一格抛错（例如盘上那份草稿读不回来）不该把后面的恢复步骤跳过
       * —— 原先整段共用一次 await，第一步失败就等于「重启之后什么都不再同步」。
       */
      for (const [name, run] of steps) {
        try {
          await run()
        } catch (e) {
          ctx.logger.warn('core ready step failed', { step: name, error: String(e) })
        }
      }
    })

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
              onExport={(threadId) => void exportThread(threadId)}
              onPin={(threadId, pinned) => {
                void api.setPinned(threadId, pinned).then((t) => stores.threads.upsert(t))
              }}
              onRename={(threadId, title) => {
                void api.renameThread(threadId, title).then((t) => stores.threads.upsert(t))
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

    // ── 命令与快捷键 ────────────────────────────────────────────────────────
    const command = (id: string, title: string, run: () => void): void => {
      ctx.contribute(builtinPoints.commands, { id, title, category: '对话', run } satisfies CommandItem)
    }
    command('conversation.newThread', '新建对话', () => newThread())
    command('conversation.focusComposer', '聚焦输入框', () => {
      document.querySelector<HTMLElement>('[data-slot="prompt-input"]')?.focus()
    })
    command('conversation.cancelTurn', '停止运行', () => {
      const current = activeThreadId()
      if (current !== null) void api.cancelTurn(current)
    })
    command('conversation.renameThread', '重命名对话', () => {
      const current = activeThreadId()
      if (current === null) return
      const thread = stores.threads.byId(current)
      if (thread === undefined) return
      const next = window.prompt('重命名对话', thread.title)
      if (next === null) return
      void api.renameThread(current, next).then((t) => stores.threads.upsert(t))
    })
    command('conversation.deleteThread', '删除对话', () => {
      const current = activeThreadId()
      const thread = current === null ? undefined : stores.threads.byId(current)
      if (thread === undefined) return
      void confirmDeleteThread(dialogs, prefs.current().general.confirmBeforeDelete, thread).then((ok) => {
        if (ok) void api.deleteThread(thread.id)
      })
    })
    command('conversation.forkThread', '分支对话', () => {
      const threadId = activeThreadId()
      if (threadId === null) return
      void api.forkThread({ threadId, undoTurns: 0 }).then((t) => {
        stores.threads.upsert(t)
        openThread(t.id)
      })
    })
    command('conversation.exportThread', '导出对话为 Markdown', () => {
      const current = activeThreadId()
      if (current !== null) void exportThread(current)
    })

    const bind = (command_: string, key: string, when?: () => boolean): void => {
      ctx.contribute(builtinPoints.keybindings, {
        command: command_,
        key,
        ...(when === undefined ? {} : { when }),
      })
    }
    bind('conversation.newThread', 'Ctrl+N')
    bind('conversation.focusComposer', 'Ctrl+L')
    bind('conversation.cancelTurn', 'Escape', () => {
      const current = activeThreadId()
      return current !== null && stores.turnStates.isRunning(current)
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

    // ── 退出拦截：有运行中的对话就先确认（07 页 §5E）─────────────────────────
    const guard = ctx.services.get(WindowCloseToken) as WindowCloseGuard
    ctx.lifecycle.onDispose(
      guard.onCloseRequested(async () => {
        const ok = await confirmQuit(dialogs, runningThreadIds().size)
        if (ok) await platform.call('app.quit', {}).catch(() => undefined)
        return ok
      }).dispose,
    )

    // ── ui-api：给其它功能的服务 ────────────────────────────────────────────
    /*
     * 技能文档：legacy 的 `auxiliaryPanel.openFile('settings', 'skill:<id>')`。新架构里
     * 「打开右坞的哪一格」由 LayoutService 说，「看的是哪一份」由上面那个值说。
     *
     * 面板**第一次被打开时才贡献**：legacy 的那一格是随文档现开的（`kind: 'file'` 的
     * pane），没有一个「还没打开就摆在标签条上」的常驻标签；贡献点里的 title 是常量，
     * 所以标签名固定写「技能文档」，与 legacy 跟着技能名走是已知差距（偏差 23）。
     *
     * 那一格的开关语义（再点同一行收起 / 换一行切过去）见 toggleSkillDocument。
     */
    let skillDocumentPanel: Disposable | undefined
    ctx.services.provide(SkillDocumentToken, {
      open: (document) => {
        toggleSkillDocument(layout, skillDocuments, document, () => {
          /*
           * 只能贡献一次：ContributionRegistry.add 见到重复 id 会抛 conflict（同一份面板
           * 注册两遍是编程错误，不是幂等操作）。
           */
          if (skillDocumentPanel === undefined) {
            skillDocumentPanel = ctx.contribute(builtinPoints.panels, {
              id: SKILL_DOCUMENT_PANEL,
              location: 'right',
              order: 30,
              title: '技能文档',
              icon: FileText,
              /* 只由打开文档的人带进来，不出现在启动器 / 加号菜单里（legacy 的 file pane 同此）。 */
              offer: false,
              component: () => <SkillDocumentPane store={skillDocuments} />,
            })
          }
        })
      },
    })

    /*
     * 右坞第一格：辅助对话（legacy 的 `assistant` pane，`AuxiliaryComposer`）。
     *
     * order 5 让它排在审查（10）/ 终端（15）/ 浏览器（20）之前 —— legacy 的启动器次序是
     * 辅助对话 / 审查 / 终端 / 浏览器。输入条要读会话的上下文（AgentControls 上下文里
     * 的工具名册），所以它与两个表面一样经 ConversationProviders 包一层。
     */
    ctx.contribute(builtinPoints.panels, {
      id: 'conversation.auxiliary',
      location: 'right',
      order: 5,
      title: '辅助对话',
      icon: MessageSquareText,
      component: () => (
        <ConversationProviders posture={posture} transcripts={transcripts}>
          <AuxiliaryComposer />
        </ConversationProviders>
      ),
    })

    ctx.services.provide(ConversationUiToken, {
      activeThreadId,
      subscribeActive: (listener) => {
        activeListeners.add(listener)
        return () => {
          activeListeners.delete(listener)
        }
      },
      runningCount: () => runningThreadIds().size,
      openThread,
      activeComposer: () => {
        const handle = stores.composerFor(activeThreadId())
        return {
          threadId: handle.threadId,
          addAttachments: handle.addAttachments,
          insertText: handle.insertText,
          submit: () => {
            handle.submit('turn')
          },
        }
      },
      draftAttachments: {
        ids: draftPin.view.ids,
        subscribe: (listener) => {
          return draftPin.view.subscribe(listener)
        },
        drop: draftPin.view.drop,
      },
    })
  },
})

/*
 * 当前前台的声明：右坞按它决定在场与否（legacy 的 workspace.tsx 由组合根一路传下
 * auxiliaryThread / activeConversationId，这里换成表面自己声明）。
 *
 * **只写不读**，且写成 effect 而不是渲染期：`setActiveOwner` 会换布局快照、触发订阅者
 * 重画，渲染期写它就是在渲染里改别人的状态（React 会警告，StrictMode 下还会转两圈）。
 * 依赖只有 owner 与服务本身，跳页时写一次。
 */
function ActiveOwner({ layout, owner }: { readonly layout: LayoutService; readonly owner: string | null }): null {
  useEffect(() => {
    layout.setActiveOwner(owner)
  }, [layout, owner])

  return null
}

/*
 * 侧栏顶行「新建对话」。**迁移自** legacy `shell/sidebar/sidebar-nav.tsx` 的第一枚
 * NavRow（icon SquarePen、label 「新建对话」）：行的几何由 workbench 的全局样式持有
 * （.sidebar-nav-row / __icon / __label，逐字迁移自 legacy 的 sidebar-rows.css），
 * 这里只贡献图标、文字与动作。高亮跟着路由：停在入口页（conversation.home）时这一行
 * 亮起（legacy 的判据是活动表面是 'ai'）。
 */
function NewConversationNavRow(): ReactNode {
  const { route } = useNavigation()
  const navigation = useService(NavigationToken) as NavigationService
  const active = route.surface === 'conversation.home'
  const className = [
    'sidebar-nav-row text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent',
    active ? 'bg-sidebar-accent text-foreground' : '',
  ]
    .filter((part) => part !== '')
    .join(' ')

  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={className}
      onClick={() => {
        navigation.navigate({ surface: 'conversation.home', params: {} })
      }}
      type="button"
    >
      <SquarePen aria-hidden="true" className="sidebar-nav-row__icon" />
      <span className="sidebar-nav-row__label">新建对话</span>
    </button>
  )
}
