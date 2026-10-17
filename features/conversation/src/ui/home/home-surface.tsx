import type { PreferencesApi } from '@poietica/feature-preferences/ui-api'
import { useWorkspacesView, type WorkspacesUi } from '@poietica/feature-workspaces/ui-api'
import { useFeatureStore } from '@poietica/ui-kernel'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ConversationApi } from '../api'
import { type EntrySelection, NEW_THREAD_KEY } from '../composer'
import { type DraftSelection, entryThreadInitOf } from '../entry-init'
import type { ConversationStores, PostureIntent, SessionRegistry } from '../session'
import {
  createThreadEntry,
  hiddenModelsOf,
  PLAN_CONTROL_ID,
  PLAN_DISABLED,
  PLAN_ENABLED,
  postureOfControl,
  sessionConfigControlsOf,
  type ThreadEntry,
  useCommandCatalog,
  withoutHiddenModels,
} from '../session'
import type { ThreadCommands } from '../shared/model/commands'
import type { SessionConfigControl } from '../shared/model/config'
import { GOAL_CONTROL_ID, GOAL_DISABLED, GOAL_ENABLED } from '../shared/model/goal-control'
import type { PreparedThread } from '../timeline'

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
import type { EntryDefaults } from './entry-defaults'

/* 没有持久意图（这一个宿主没接）时的订阅占位：引用终生不变，否则 useSyncExternalStore 每帧重订。 */
const NO_SUBSCRIPTION = (): (() => void) => () => undefined

const NO_SELECTION: DraftSelection = Object.freeze({})

export interface HomeSurfaceProps {
  readonly api: ConversationApi
  readonly stores: ConversationStores
  readonly workspaces: WorkspacesUi
  /** 批准方式的持久意图：入口这一格还没有会话，少了它每次重开软件都看到默认档（真实故障）。 */
  readonly posture?: PostureIntent | undefined
  readonly sessions: SessionRegistry
  readonly onOpenThread: (threadId: string) => void
  /**
   * 在入口页执行了一条斜杠命令：对话号已铸好，由组合根记下这句命令、跳到那条对话，在那里执行（输出也在那里看）。
   * 入口页没有会话，命令只能落在一条新对话上 —— 与在终端里新开一个 agent 再敲命令是同一件事。
   */
  readonly onStartCommand: (threadId: string, text: string) => void
  /** 偏好：读设置页关掉的模型（`modelPicker.hiddenModels`）。订阅着读，开关一拨菜单当场变；没接就不藏。 */
  readonly preferences?: PreferencesApi | undefined
  /** 「新对话默认」那一份意图：选模型 / 档位写穿它，草稿只留没写成功的那一笔。没接就只改本地草稿（旧行为）。 */
  readonly entryDefaults?: EntryDefaults | undefined
}

export function HomeSurface({
  api,
  entryDefaults,
  onOpenThread,
  onStartCommand,
  posture: postureIntent,
  preferences,
  sessions,
  stores,
  workspaces,
}: HomeSurfaceProps): ReactElement {
  const [threadId, setThreadId] = useState<string | null>(null)
  /* 草稿存在功能 store 里（随 `conversation.drafts` 落盘）：原先住在组件 useState，一重启就回到默认模型与默认档位（真实故障）。订阅着读，因为开机读盘回来之前是空的。 */
  const stored = useFeatureStore(stores.composer.store, (s) => s.drafts[NEW_THREAD_KEY]?.selection)
  /* 空草稿用模块级那一份，不写 `stored ?? {}`：新对象换掉 `draft` 引用就渲染 → effect → setState 转个不停，测试里 act() 等不到队列清空（全仓 33 例 DOM 用例连带超时）。 */
  const draft: DraftSelection = stored ?? NO_SELECTION
  const setDraft = useCallback(
    (patch: EntrySelection | ((held: DraftSelection) => EntrySelection)): void => {
      const next = typeof patch === 'function' ? patch(stored ?? {}) : patch
      stores.composer.setSelection(null, next)
    },
    [stored, stores.composer],
  )
  const [controls, setControls] = useState<readonly SessionConfigControl[]>([])
  const hiddenModels = useSyncExternalStore(
    preferences?.subscribe ?? NO_SUBSCRIPTION,
    useCallback(() => hiddenModelsOf(preferences?.current()), [preferences]),
  )
  /* 只藏画出来的那一份：建线程时交给 Core 的仍是完整控件表（`prepare` 里的 controls）。 */
  const shownControls = useMemo(() => withoutHiddenModels(controls, hiddenModels), [controls, hiddenModels])

  /* 持久意图订阅着读；用户没在这一格动过批准方式时画的就是它，一点草稿就压过它。 */
  const storedPosture = useSyncExternalStore(
    postureIntent?.subscribe ?? NO_SUBSCRIPTION,
    useCallback(() => postureIntent?.read(), [postureIntent]),
  )
  const inherited = storedPosture === undefined ? undefined : postureOfControl(storedPosture)
  const effectivePosture = draft.posture ?? inherited

  /* 惰性初始化用 ref 不用 `useMemo`：这一份是状态不是缓存，StrictMode 会把渲染跑两遍造出两个实例。 */
  const entryRef = useRef<ThreadEntry | null>(null)
  if (entryRef.current === null) {
    entryRef.current = createThreadEntry()
  }
  const entry = entryRef.current

  /* 盘上的草稿读回来（或确定读不回来）之前不要控件表：空草稿换来的兜底先画出来、再被盘上的选择盖掉，就是启动时的错位。 */
  const entryReady = useFeatureStore(stores.composer.store, (s) => s.entryReady)
  /*
   * 后发先至：hydrate、posture.load、`controls.draftChanged`（Core 启动时模型目录变了也会发）都会触发一次读，
   * 几次请求在 Core 里的 await 深浅不同，旧请求的应答可能后到。只认最后一次发出的那一份，旧的直接丢。
   */
  const readSeq = useRef(0)

  /* `draft` 是依赖：换了模型，思考档位的候选要换成那条模型的梯子；全空草稿也要读一次拿默认梯子。 */
  const readDraft = useCallback(() => {
    if (!entryReady) return
    const seq = ++readSeq.current
    /* 继承来的那一档也要带进草稿表，不然首帧画的是引擎默认档。 */
    void api
      .getDraftControls({
        model: draft.model ?? null,
        thinking: draft.thinking ?? null,
        posture: effectivePosture ?? null,
        /* 兜底（没选过、也没有全局默认）时别选中设置页关掉的模型 —— 它在菜单里都不出现 */
        hidden: hiddenModels,
      })
      .then(
        /* 就地盖到表上：不盖的话用户点了「计划」下一帧就被刷回去。 */
        (next) => {
          if (seq !== readSeq.current) return
          setControls(applyDraftModes(sessionConfigControlsOf(next), { plan: draft.plan, goal: draft.goal }))
        },
        () => undefined,
      )
  }, [api, draft, effectivePosture, entryReady, hiddenModels])

  useEffect(() => {
    readDraft()
  }, [readDraft])

  useEffect(() => {
    const sub = api.onDraftControlsChanged(readDraft)
    return () => {
      sub.dispose()
    }
  }, [api, readDraft])

  /* 项目名单订阅着读：原先读一次性快照，首帧 store 还空着，「选择项目」就被写死到屏幕上（真实故障）。 */
  const view = useWorkspacesView(workspaces)

  /* 交回 `{key, port}`：号是这一刻才由 Core 铸出来的，端口按号建。第二次提交直接交回手上那一份，不再建第二条线程。 */
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
    /* 计划：铸出号之后、submit 之前补调一次 —— 入口页没有会话，用户点的那一下只能先记本地。
       `setPlanMode` 会让 Core 建起会话，所以要 `await` 住才不会被 submit 抢跑；目标走「发送时生效」。 */
    if (prepared !== null && draft.plan === true) {
      await api.setPlanMode(prepared.key, true)
    }
    return prepared
  }, [api, controls, draft, effectivePosture, entry, sessions, stores.threads, view.active?.id, view.items])

  /*
   * 模型 / 档位：先记进草稿（屏幕当场跟手），再写穿「新对话默认」意图，写成功由 entryDefaults 从草稿里抹掉 ——
   * 与批准方式同一个形制：跨会话的决定只有一份。三个 id 就是 `sessionConfigControlsOf` 造的那三个。
   */
  const remember = (): void => {
    void entryDefaults?.flush().catch(() => undefined)
  }

  /* 入口页的斜杠命令：表按工作区读；执行 = 先铸出这条对话，再交给组合根跳过去执行。铸号失败就写在命令输出那一块。 */
  const catalog = useCommandCatalog(api, view.active?.id ?? view.items[0]?.id ?? null)
  const [commandFailure, setCommandFailure] = useState<ThreadCommands['output']>(null)
  const commands = useMemo<ThreadCommands>(
    () => ({
      list: catalog,
      output: commandFailure,
      dismissOutput: () => setCommandFailure(null),
      run: async (text: string) => {
        const command = text.trim()
        try {
          const prepared = await prepare()
          if (prepared !== null) onStartCommand(prepared.key, command)
        } catch (error) {
          setCommandFailure({ command, lines: [error instanceof Error ? error.message : String(error)] })
        }
      },
    }),
    [catalog, commandFailure, onStartCommand, prepare],
  )

  /* 仅改草稿的这几档（计划 / 目标）不下发、不写任何全局默认；模型与档位在上面写穿「新对话默认」那一份意图。 */
  const select = (controlId: string, value: string): void => {
    if (controlId === 'model') {
      const at = value.indexOf('/')
      if (at > 0) {
        setDraft((held) => ({ ...held, model: { provider: value.slice(0, at), id: value.slice(at + 1) } }))
        remember()
      }
      return
    }
    if (controlId === 'thought') {
      setDraft((held) => ({ ...held, thinking: value }))
      remember()
      return
    }
    if (controlId === 'permission') {
      /* 胶囊给的是产品值，草稿存引擎值；批准方式是跨会话的决定，所以要同时落成持久意图。 */
      const posture = postureOfControl(value)
      if (posture !== undefined) {
        setDraft((held) => ({ ...held, posture }))
        postureIntent?.write(value)
      }
      return
    }
    /* 计划 / 目标在入口这一格也只改本地草稿，落地在 prepare() 之后的补调。 */
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
      commands={commands}
      controls={shownControls}
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
        /* 选择器交回的是 `WorkspaceChoice.id`（工作区实体 id）。此前拿它比 `w.path`：永远不相等，切换到新工作区后名字要等重挂载才变（真机故障）。 */
        onChoose: (workspaceId) => workspaces.setActive(workspaceId),
        /* 点「不在项目中工作」（folder → ×）把下一条会话放进临时工作目录（`createScratch`）。 */
        onClear: () => void workspaces.createScratch(),
      }}
    />
  )
}
