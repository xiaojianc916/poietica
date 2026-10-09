import { useWorkspacesView, type WorkspacesUi } from '@poietica/feature-workspaces/ui-api'
import { useFeatureStore } from '@poietica/ui-kernel'
import { type ReactElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionConfigControl } from '../agent/config'
import type { ConversationApi } from '../api'
import type { PostureIntent } from '../configuration/posture-intent'
import {
  PLAN_CONTROL_ID,
  PLAN_DISABLED,
  PLAN_ENABLED,
  postureOfControl,
  sessionConfigControlsOf,
} from '../control-shapes'
import { type DraftSelection, entryThreadInitOf } from '../entry-init'
import type { ConversationStores } from '../stores'
import { type EntrySelection, NEW_THREAD_KEY } from '../stores/composer'
import type { SessionRegistry } from '../stores/session-registry'
import { createThreadEntry, type ThreadEntry } from '../stores/thread-entry'
import type { PreparedThread } from '../transcript/transcript-store'
import { GOAL_CONTROL_ID, GOAL_DISABLED, GOAL_ENABLED } from './goal/goal-control'

/**
 * 把入口页那两格草稿盖到引擎给的控件表上（07 页 §5E 的「只改本地草稿」）。
 *
 * 只动 `current`：候选、标签、`appliesOnSubmit` 都还是引擎那一份。
 * 表里没有那一项（agent 设置里关掉了）就什么都不做 —— 不画出来的东西不盖。
 */
function applyDraftModes(
  controls: readonly SessionConfigControl[],
  draft: { readonly plan?: boolean | undefined; readonly goal?: boolean | undefined },
): readonly SessionConfigControl[] {
  if (draft.plan === undefined && draft.goal === undefined) return controls
  return controls.map((control) => {
    if (control.id === PLAN_CONTROL_ID && draft.plan !== undefined) {
      return { ...control, current: draft.plan ? PLAN_ENABLED : PLAN_DISABLED }
    }
    if (control.id === GOAL_CONTROL_ID && draft.goal !== undefined) {
      return { ...control, current: draft.goal ? GOAL_ENABLED : GOAL_DISABLED }
    }
    return control
  })
}

import { AssistantSurface } from './assistant-surface'

/*
 * 入口表面（路由 `conversation.home`，基准界面 #01）。
 *
 * legacy 里入口与会话是**同一棵树的两个相位**（assistant-surface 的 data-phase="entry" | "live"），
 * 因为那时还没有路由。新架构把它们拆成两个 surface（06 页的 surfaces 贡献点），
 * 中间那一步 —— 「这一格还没有线程，第一句话发出去时才铸号」—— 就落在这里：
 *
 *   prepare()：createThread 铸号 → 记进线程列表 → 把会话端口交给表面（端口按线程建）。
 *   onUserMessage()：第一句话落地之后导航到线程页；那边的端口读同一份会话文件，
 *   时间线因此接着长，不会丢第一句。
 *
 * 界面本体一字未改：还是 AssistantSurface 的 entry 相位（吉祥物 + 输入框 + 压舱块）。
 */

/*
 * 入口页那排选择器的**本地草稿**（方案 §07「入口页改选择只改本地草稿」）：
 * 形状与「发送时取哪几格」的判据都住在 ../entry-init.ts（纯函数，可单测）。
 */

/* 没有持久意图（这一个宿主没接）时的订阅占位：引用终生不变，useSyncExternalStore 才不会每帧重订。 */
const NO_SUBSCRIPTION = (): (() => void) => () => undefined

/** 还没动过任何一格时的选择器草稿。引用终生不变：它是下面 `readDraft` 的依赖之一。 */
const NO_SELECTION: DraftSelection = Object.freeze({})

export interface HomeSurfaceProps {
  readonly api: ConversationApi
  readonly stores: ConversationStores
  readonly workspaces: WorkspacesUi
  /**
   * 批准方式的持久意图。入口这一格还没有会话，所以「上一趟按下的那一档」只能从
   * 这里读 —— 少了它，用户每次重开软件在这一格看到的都是默认档（真实故障）。
   */
  readonly posture?: PostureIntent | undefined
  /** 会话端口的注册表：铸出号之后从它取那一根（身份由它单点持有）。 */
  readonly sessions: SessionRegistry
  readonly onOpenThread: (threadId: string) => void
}

export function HomeSurface({
  api,
  onOpenThread,
  posture: postureIntent,
  sessions,
  stores,
  workspaces,
}: HomeSurfaceProps): ReactElement {
  const [threadId, setThreadId] = useState<string | null>(null)
  /*
   * 入口页那排选择器的本地草稿存在**功能的草稿 store** 里（home 页的键是 `null`），
   * 与正文草稿同一格、随 `conversation.drafts` 一起落盘（07 页 §5E）。原先它住在
   * 组件的 `useState` 里：一重启就没了，屏幕回到默认模型与默认档位（真实故障）。
   *
   * 订阅着读：那份草稿在开机读盘回来之前是空的，读快照的话首帧之后就再也不换。
   */
  const stored = useFeatureStore(stores.composer.store, (s) => s.drafts[NEW_THREAD_KEY]?.selection)
  /*
   * 空草稿用**模块级那一份**，不写 `stored ?? {}`：后者每次渲染都造一个新对象，而
   * `draft` 是下面 `readDraft` 的依赖 —— 引用一换，取草稿表的那条 effect 每帧都重跑，
   * `setControls` 每次都交回新数组，于是渲染 → effect → setState → 渲染地转个不停。
   * 真机上的表现是入口页反复重取 `controls.draft`；测试里的表现更硬：React 的 act()
   * 要等更新队列清空，这条循环让它永远等不到（全仓 33 例 DOM 用例连带超时）。
   */
  const draft: DraftSelection = stored ?? NO_SELECTION
  const setDraft = useCallback(
    (patch: EntrySelection | ((held: DraftSelection) => EntrySelection)): void => {
      const next = typeof patch === 'function' ? patch(stored ?? {}) : patch
      stores.composer.setSelection(null, next)
    },
    [stored, stores.composer],
  )
  const [controls, setControls] = useState<readonly SessionConfigControl[]>([])

  /*
   * 持久意图**订阅**着读（它开机那一刻才从盘上回来，读快照的话首帧之后就再也不换）。
   * 用户没在这一格动过批准方式时，画的就是它 —— 于是「上次选了完全访问」在这台机器上
   * 重开软件仍然成立。用户一点，草稿那份就压过它。
   */
  const storedPosture = useSyncExternalStore(
    postureIntent?.subscribe ?? NO_SUBSCRIPTION,
    useCallback(() => postureIntent?.read(), [postureIntent]),
  )
  const inherited = storedPosture === undefined ? undefined : postureOfControl(storedPosture)
  const effectivePosture = draft.posture ?? inherited

  /*
   * 铸号机：防重入与「号只铸一次」两件事住在 stores/thread-entry.ts（那里有无 DOM 的
   * 单测钉住判据）。组件只负责在调用的这一刻把工作区与草稿算好交给它。
   *
   * 惰性初始化用 ref 而不是 `useMemo`：StrictMode 会把渲染跑两遍，而这一份是**状态**
   * 不是缓存 —— 跑两遍造出两个实例，第二次那一个会带着空白的「已经铸过的号」，
   * 防重入的判据当场失效。
   */
  const entryRef = useRef<ThreadEntry | null>(null)
  if (entryRef.current === null) {
    entryRef.current = createThreadEntry()
  }
  const entry = entryRef.current

  /*
   * 读草稿表。`draft` 是依赖：用户在入口页改了模型，思考档位的候选要跟着换成**那条模型**
   * 的梯子（与会话里同一条规则），所以改一格就重读一次。
   *
   * 全空草稿也要读一次：那一次拿到的是默认模型与它自己的档位梯子 —— 也就是「还没动过
   * 任何东西」时该显示的那一份。
   */
  const readDraft = useCallback(() => {
    /* 继承来的那一档也要带进草稿表：不然首帧画的是引擎默认档、不是人上次选的那一档。 */
    void api
      .getDraftControls({
        model: draft.model ?? null,
        thinking: draft.thinking ?? null,
        posture: effectivePosture ?? null,
      })
      .then(
        /*
         * 两档草稿在这里**就地盖到表上**（产品负责人 2026-10-07 定稿）：引擎那一份草稿表
         * 报的是「会话里此刻是什么样」，而入口页这两格是「还没落地、等人发送」——
         * 不盖的话，用户点了「计划」下一帧就被引擎的值刷回去，看起来像点了没反应。
         */
        (next) => setControls(applyDraftModes(sessionConfigControlsOf(next), { plan: draft.plan, goal: draft.goal })),
        () => undefined,
      )
  }, [api, draft, effectivePosture])

  useEffect(() => {
    readDraft()
  }, [readDraft])

  /* 模型列表变了（装/卸服务商、启停模型）→ 重读草稿表（方案 §05 的 controls.draftChanged）。 */
  useEffect(() => {
    const sub = api.onDraftControlsChanged(readDraft)
    return () => {
      sub.dispose()
    }
  }, [api, readDraft])

  /*
   * 项目名单与当前项目**订阅**着读。
   *
   * 原先读的是 workspaces.store.getState() 与 workspaces.active()：两者都是一次性
   * 快照。首帧时 store 还是空的（onCoreReady 的 reload 没回来），输入框下方那一行因此
   * 把「选择项目」写死到屏幕上 —— 之后工作区到了也没有任何东西会让它重画，要人手切一次
   * 页面（组件重挂）才对（真实故障）。这里换成订阅式视图。
   */
  const view = useWorkspacesView(workspaces)

  /*
   * 铸号：把入口页选好的三格带进 `threads.create`（方案的发送流程第一条），
   * 并交回这一条提交要落的那个键与它的端口。
   *
   * 交回 `{key, port}` 而不是 true/false：号是**这一刻**才铸出来的（05 页 §11.4 的
   * `threads.create` 由 Core 铸号），端口按号建，所以两样都只能在这里给。调用方
   * （transcript store 的 `send`）拿它们把这一条提交落到正确的对话上 ——
   * 入口那一格的键是 `''`，新号到手之后每一次落笔都用新键。
   *
   * 已经铸过号（第二次提交，或只是把这一格再发一次）就直接交回手上那一份，
   * **不再建第二条线程**。
   */
  const prepare = useCallback(async (): Promise<PreparedThread | null> => {
    const workspaceId = view.active?.id ?? view.items[0]?.id
    const prepared = await entry.prepare({
      init: entryThreadInitOf({
        workspaceId,
        draft,
        controls,
        ...(effectivePosture === undefined ? {} : { posture: effectivePosture }),
      }),
      create: (init) => api.createThread(init),
      created: (thread) => {
        stores.threads.upsert(thread)
        setThreadId(thread.id)
      },
      sessions,
    })
    /*
     * 入口这一格的两档草稿（产品负责人 2026-10-07 定稿）：
     *
     * - 计划：**铸出号之后、submit 之前**补调一次 —— 入口页没有会话，用户点的那一下只能
     *   先记本地。`setPlanMode` 会让 Core 建起会话（pool.acquire），所以它就是那句
     *   「openSession 之后」；这里 `await` 住，submit 才不会被它抢跑。
     * - 目标：不在这里做。它走「发送时生效」，由 session-port 在提交前用这一句的正文设
     *   下去（objective 就是那一句，这一层拿不到）。
     */
    if (prepared !== null && draft.plan === true) {
      await api.setPlanMode(prepared.key, true)
    }
    return prepared
  }, [api, controls, draft, effectivePosture, entry, sessions, stores.threads, view.active?.id, view.items])

  /*
   * 在入口页改一格：**只改本地草稿**（方案 §07），不下发、不写任何全局默认。
   *
   * 三个 id 是 `sessionConfigControlsOf` 造出来的那三个（'model' / 'thought' /
   * 'permission'），与会话页 `onSelectControl` 收到的同一组。
   */
  const select = (controlId: string, value: string): void => {
    if (controlId === 'model') {
      const at = value.indexOf('/')
      if (at > 0) setDraft((held) => ({ ...held, model: { provider: value.slice(0, at), id: value.slice(at + 1) } }))
      return
    }
    if (controlId === 'thought') {
      setDraft((held) => ({ ...held, thinking: value }))
      return
    }
    if (controlId === 'permission') {
      /*
       * 同上：胶囊给的是产品值，草稿存引擎值（发送时带进 threads.create）。
       *
       * 同时落成**持久意图**（产品值原样交给它）：批准方式是一个跨会话的决定，legacy
       * 在入口页改它也是一样的落法 —— 只改这一趟的草稿就等于每次重开都要重选。
       */
      const posture = postureOfControl(value)
      if (posture !== undefined) {
        setDraft((held) => ({ ...held, posture }))
        postureIntent?.write(value)
      }
      return
    }
    /* 计划 / 目标：入口这一格只改本地草稿，落地在 prepare() 之后的补调（见 onOpened） */
    if (controlId === PLAN_CONTROL_ID) {
      setDraft((held) => ({ ...held, plan: value === PLAN_ENABLED }))
      return
    }
    if (controlId === GOAL_CONTROL_ID) {
      setDraft((held) => ({ ...held, goal: value === GOAL_ENABLED }))
    }
  }

  return (
    <AssistantSurface
      controls={controls}
      endpoint={threadId ?? ''}
      isNew
      onSelectControl={select}
      onUserMessage={(id) => {
        onOpenThread(id)
      }}
      prepare={prepare}
      workspace={{
        choices: view.items.map((w) => ({ id: w.id, name: w.name })),
        current: view.active,
        onBrowse: () => void workspaces.pickAndAdd(),
        /*
         * 选择器交回的是 `WorkspaceChoice.id`，而新架构里它就是**工作区实体 id**
         * （`choices` 上一行给的正是 `w.id`）。此前这里拿它去比 `w.path`：uuid 与路径
         * 永远不相等，`setActive` 因此从不被调用 —— 屏幕上工作区名字要等下一次重挂载
         * 才变（真机故障：切换工作区后名字不立刻变更）。
         */
        onChoose: (workspaceId) => workspaces.setActive(workspaceId),
        /*
         * legacy 的入口页在工作区胶囊左侧有「不在项目中工作」那一格（folder → ×），
         * 点它就把下一条会话放进一个独立的临时工作目录（`clearWorkspace`）。新架构里
         * 「临时工作目录」由 workspaces 契约的 `createScratch` 提供 —— 这是同一件事在
         * 新数据模型下的落点（05 页的 `ThreadInit.workspaceId` 必填，没有「无工作区」
         * 这一档）。偏差记入 docs/refactor-log.md。
         */
        onClear: () => void workspaces.createScratch(),
      }}
    />
  )
}
