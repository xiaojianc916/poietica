/*
 * 桥的入口：omp SDK 编进这个进程，与 Rust 用 NDJSON 说话。
 *
 * 它只有三件事：把 Rust 的命令翻成 SDK 调用、把 SDK 的 typed event 投影成
 * transcript ops、把两者都写成一行 JSON 到 stdout。落账、超时、取消的重启
 * 都归 Rust —— 这里不做第二套（AGENTS.md §5）。
 *
 * 这个文件被 tools/agent/build-bridge.ts 编成单文件可执行，用户不需要装 omp。
 */

import path from 'node:path'
import type { AgentSession, AgentSessionEvent } from '@oh-my-pi/pi-coding-agent'
import {
  type AuthStorage,
  createAgentSession,
  discoverAuthStorage,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  Settings,
} from '@oh-my-pi/pi-coding-agent'
import { getUi } from '@oh-my-pi/pi-coding-agent/config/settings-schema'
import {
  disableProvider,
  enableProvider,
  initializeWithSettings,
} from '@oh-my-pi/pi-coding-agent/discovery'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import type { TranscriptOperation } from '@poietica/transcript'
import { createUIContext, DialogDesk, labelFor } from './approval.ts'
import { aliasOf, executeCatalog } from './catalog.ts'
import { removeProvider, writeProvider, writeProviderOverride } from './models-file.ts'
import { outcomeOf, type TurnOutcome } from './outcome.ts'
import { TranscriptProjector } from './projection.ts'
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeFrame,
  type GoalSnapshot,
  type SelectorControl,
  type UsageSnapshot,
} from './protocol.ts'
import { TranscriptMirror } from './transcript-mirror.ts'

const write = (frame: BridgeFrame): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

/*
 * omp 的目标类型。它住在 pi-tui 里、不由 SDK 再导出，所以从会话的读法上取 ——
 * 比为了一个类型注解多引一条依赖边干净。
 */
type GoalOfSession = NonNullable<ReturnType<AgentSession['getGoalModeState']>>['goal']

const emit = (event: BridgeEvent): void => {
  write({ type: 'event', event })
}

/** 诊断走 stderr：stdout 是协议通道，多一个字都会毁掉那一行。 */
const log = (...parts: readonly unknown[]): void => {
  process.stderr.write(`${parts.map(String).join(' ')}\n`)
}

/** 一条会话。多会话并发是常态，所以这里是一张表而不是一个当前值。 */
interface Session {
  readonly id: string
  readonly agent: AgentSession
  readonly projector: TranscriptProjector
  /** 屏幕经过的镜像：ops 推出去的同时落进它，打开与追赶两条读从它答。 */
  readonly mirror: TranscriptMirror
  /** 模型目录读的是它；每一条会话自己那份注册表。 */
  readonly registry: ModelRegistry
  /** 凭据读写走它（agent 自己的 agent.db）。 */
  readonly authStorage: AuthStorage
  /** 会话自己那份设置（受控 home 的 config.yml），选择器与写入面都读它。 */
  readonly settings: Settings
  /** 用户自建的 provider 定义住在它（受控 home 的 models.yml）。 */
  readonly modelsFile: string
  unsubscribe: (() => void) | null
  /** 等答复的对话框：请求由它签发号，答复按同一个号回来。 */
  readonly desk: DialogDesk
  /** 用户在这条会话里选过的默认模型；目录那一页读它。 */
  defaultModel: string | null
}

const sessions = new Map<string, Session>()
let active: string | null = null

/*
 * 设置走 omp 自己的持久层（受控 home 的 config.yml），不是内存里的孤本。
 *
 * 用户的模型角色、审批模式、provider 启停都住在那里，omp 自己热重载它。
 *
 * 外来 provider（别人的 ~/.claude/.codex/… 配置源）一律停用：那是别人家的配置，
 * 不是我们的。停用走**官方那一条写入面**（capability 的 disableProvider → 全局
 * 层 + 落盘），不写运行时覆盖层 —— 覆盖层是整份替换数组的，一旦把此刻读到的表
 * 钉进去，用户之后在任何地方启停 provider 都会被它盖住：删掉再建的 provider
 * 永远回不来，界面看上去「写了配置完全没反应」。这条已经发生过一次。
 *
 * 每条会话共用同一个实例：Settings.init 是进程级单例（它自己按 cwd 缓存），
 * 多开一条会话不该多读一遍盘。
 */
const FOREIGN_PROVIDERS: readonly string[] = [
  'claude',
  'claude-plugins',
  'codex',
  'gemini',
  'opencode',
  'cursor',
  'windsurf',
  'cline',
  'github',
  'vscode',
  'agents-md',
]

let settingsPromise: Promise<Settings> | null = null

function settingsFor(): Promise<Settings> {
  settingsPromise ??= Settings.init().then(async (instance) => {
    /*
     * capability 层要拿到实例才知道往哪落盘；createAgentSession 之后还会再装一次，
     * 装两次是幂等的（它只按 settings 重读那张表）。
     */
    initializeWithSettings(instance)

    /* 已经在表里的不重复写：每次开会话都重写一遍 config.yml 是没必要的盘上动作。 */
    const disabled = new Set(instance.get('disabledProviders'))
    const missing = FOREIGN_PROVIDERS.filter((provider) => !disabled.has(provider))

    if (missing.length > 0) {
      for (const provider of missing) {
        disableProvider(provider)
      }
      await instance.flush()
    }

    return instance
  })

  return settingsPromise
}

async function openSession(cwd: string): Promise<string> {
  const authStorage = await discoverAuthStorage()
  /*
   * 注册表照官方那一份建：ModelRegistry 读内置目录 + 用户 models.yml（provider
   * 覆盖、发现式 provider 都在里面）。refresh 是它自己的合并规则，别手搓。
   */
  const modelRegistry = new ModelRegistry(authStorage)
  await modelRegistry.refresh()

  /*
   * 对话框的号由我们签发。sessionId 先占一个空串：闸门可能在会话对象拿到号之前
   * 就被调到（上游在建会话时就装好了包装器），闭包里读一个还没赋值的变量会推出去
   * 一个 undefined。
   */
  let id = ''

  const desk = new DialogDesk((frame) => {
    emit({ kind: 'dialog_requested', sessionId: id, request: frame })
  })

  const { session, setToolUIContext } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settings: await settingsFor(),
    sessionManager: SessionManager.create(cwd),
    /*
     * hasUI 必须为 true，否则上游的授权闸门 fail closed：非 yolo 模式下每一次
     * write/exec 都会抛「requires approval but no interactive UI available」。
     * 我们给的不是终端界面，但它确实是「有人能答」。
     */
    hasUI: true,
  })

  id = session.sessionId ?? crypto.randomUUID()

  const record: Session = {
    id,
    agent: session,
    projector: new TranscriptProjector(),
    mirror: new TranscriptMirror(id),
    registry: modelRegistry,
    authStorage,
    settings: session.settings,
    /*
     * 用户自建 provider 的定义文件。路径取自上游自己的目录（`getAgentDir`），
     * 拼法与官方一致（model-registry.ts 的 `path.join(getAgentDir(), "models.yml")`）——
     * 受控 home 由 `PI_CODING_AGENT_DIR` 定，所以它落在 agent 自己的家里。
     */
    modelsFile: path.join(getAgentDir(), 'models.yml'),
    unsubscribe: null,
    desk,
    defaultModel: session.model === undefined ? null : aliasOf(session.model),
  }

  const uiContext = createUIContext(desk)

  setToolUIContext(uiContext, true)

  /*
   * 两步缺一不可，这是官方 RPC 模式（modes/rpc/rpc-mode.ts）的同一套：
   * setToolUIContext 只把 UI 交给工具上下文；**授权闸门读的是 runner.hasUI()**，
   * 而 runner 的 UI 由 initializeExtensions 装进去。只做第一步的话闸门仍然
   * fail closed，非 yolo 模式下每一次 write/exec 都会抛「no interactive UI」。
   */
  await initializeExtensions(session, {
    reportSendError: (action, error) => {
      log('extension send failed', action, error.message)
    },
    reportRuntimeError: (error) => {
      log('extension runtime error', error.event, String(error.error))
    },
    mode: 'print',
    uiContext,
  })

  record.unsubscribe = session.subscribe((event) => {
    handleEvent(record, event)
  })
  sessions.set(id, record)
  active = id

  emit({
    kind: 'selectors',
    sessionId: id,
    controls: await readSelectors(record),
    goal: readGoal(record),
  })

  return id
}

function handleEvent(record: Session, event: AgentSessionEvent): void {
  const project = record.projector
  let ops: ReturnType<TranscriptProjector['turnEnd']> = []
  /* 轮终要等这一批 ops 先落地：账上「这一轮结束了」不能早于「这一轮写了什么」。 */
  let ending: TurnOutcome | null = null

  switch (event.type) {
    case 'turn_start':
      /* 用户那一轮由 prompt 命令开，这里只接 agent 自己的 turn。 */
      break

    case 'message_update': {
      const inner = event.assistantMessageEvent
      if (inner.type === 'text_delta') {
        ops = project.textDelta(inner.delta)
      } else if (inner.type === 'thinking_delta') {
        ops = project.thinkingDelta(inner.delta)
      }
      break
    }

    case 'tool_execution_start':
      ops = project.toolStart({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      })
      break

    case 'tool_execution_end':
      ops = project.toolEnd({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        ...(event.isError === undefined ? {} : { isError: event.isError }),
      })
      break

    case 'notice':
      ops = project.notice(event.level, event.message, event.source)
      break

    /*
     * 模型换了、思考档位换了，选择器那一栏就变了。
     *
     * 这是上游自己报的两个事件（agent-session-events.ts 的 `model_changed` 与
     * `thinking_level_changed`），不是我们去轮询。换了模型，能选的档位跟着换
     * （`getAvailableThinkingLevels` 是按当前模型算的），所以两个都重报一遍。
     */
    case 'model_changed':
    case 'thinking_level_changed':
      reselect(record)
      break

    /*
     * 目标变了（agent 自己调的 `goal` 工具、预算翻转、完成）。
     *
     * 与模型/档位同一条路重报一次选择器事件：目标就挂在那条事件的车上，所以
     * 「重报」只有一个动作，不是两个各自会漏的出口。
     */
    case 'goal_updated':
      reselect(record)
      break

    case 'agent_end':
      /* isTerminal 为 false 时后面还有活干，这一轮没真结束。 */
      if (event.isTerminal !== false) {
        const outcome = outcomeOf(record.agent.getLastAssistantMessage())
        ops = project.turnEnd(outcome.kind, outcome.message)
        ending = outcome
      }
      break

    default:
      break
  }

  if (ops.length > 0) {
    pushTranscript(record, ops)
  }

  if (ending !== null) {
    emit({
      kind: 'turn_end',
      sessionId: record.id,
      outcome: ending.kind,
      ...(ending.message === undefined ? {} : { message: ending.message }),
    })
    reportUsage(record)
  }
}

/**
 * 重报这条会话的选择器。
 *
 * 选择器是「此刻能改什么」，`readSelectors` 是唯一的产地；这里只是把它推出去。
 */
function reselect(record: Session): void {
  emit({
    kind: 'selectors',
    sessionId: record.id,
    controls: readSelectors(record),
    goal: readGoal(record),
  })
}

function reportUsage(record: Session): void {
  const stats = record.agent.getSessionStats()
  const context = stats.contextUsage

  const usage: UsageSnapshot = {
    used: context?.tokens ?? stats.tokens.input,
    size: context?.contextWindow ?? 0,
    inputOther: stats.tokens.input,
    inputCacheRead: stats.tokens.cacheRead,
    inputCacheCreation: stats.tokens.cacheWrite,
  }

  emit({ kind: 'usage', sessionId: record.id, usage })
}

/*
 * 这条会话此刻能改的选择器。
 *
 * 三格，各有各的产地：
 *
 * - model：`session.model` 是此刻在用的，`getAvailableModels()` 是能选的（它已经
 *   按 `enabledModels` 筛过，与官方选择器同一份）。
 * - thinking：上游的取值域不是「模型支持的档位」那一列 —— 它是
 *   `off → auto → minimal..max`（model-controls.ts 的 cycleThinkingLevel 就是这个
 *   顺序），而 `getAvailableThinkingLevels()` 只给后一段。所以 current 报
 *   `configuredThinkingLevel()`（保留 auto），候选是 off + auto + 模型支持的档位。
 *   报 effective 的 `thinkingLevel` 会把 auto 显示成它此刻临时落到的值，人一按就
 *   变成钉死；`inherit` 是会话内部的回落值，上游的 CLI 取值域刻意不收它
 *   （pi-tui 的 parseCliThinkingLevel 显式拒），所以这里也不列它。
 * - permission：上游没有「权限档位」这个控制项，它只有 `tools.approvalMode`
 *   一个设置（settings-schema.ts：always-ask / write / yolo），闸门读的就是它。
 *   产品那三档与它逐档对应（见 POSTURES），映射只在这里做一次。
 */
function readSelectors(record: Session): SelectorControl[] {
  const controls: SelectorControl[] = []
  const model = record.agent.model

  if (model !== undefined) {
    const available = record.agent.getAvailableModels()
    controls.push({
      id: 'model',
      purpose: 'model',
      current: aliasOf(model),
      choices: available.map((entry) => ({
        value: aliasOf(entry),
        label: entry.name ?? entry.id,
      })),
    })
  }

  const levels = record.agent.getAvailableThinkingLevels()
  const configured = record.agent.configuredThinkingLevel()

  if (levels.length > 0 && configured !== undefined) {
    controls.push({
      id: 'thinking',
      purpose: 'thinking',
      current: configured,
      /*
       * 候选与官方 cycle 同一份、同一顺序：off → auto → 模型支持的档位
       * （model-controls.ts 的 cycleThinkingLevel 就是这么排的）。
       *
       * 标签与说明取自上游自己的那一张表（settings-schema.ts 的
       * "defaultThinkingLevel".ui.options，经 getUi 读）。逐档写死会跟上游分叉：
       * 上游改了档位的说法，屏幕上还是我们抄的那一句。
       */
      choices: [OFF_THINKING, AUTO_THINKING, ...levels].map((level) => {
        const option = THINKING_OPTIONS.get(level)

        return {
          value: level,
          label: option?.label ?? level,
          ...(option?.description === undefined ? {} : { detail: option.description }),
        }
      }),
    })
  }

  const approval = record.settings.get('tools.approvalMode')
  const posture = POSTURES.find((entry) => entry.mode === approval)

  if (posture !== undefined) {
    controls.push({
      id: 'permission',
      purpose: 'permission',
      current: posture.value,
      choices: POSTURES.map((entry) => ({ value: entry.value, label: entry.label })),
    })
  }

  return controls
}

/*
 * 产品那三档批准方式 → 上游的 tools.approvalMode。
 *
 * 上游只有三档（settings-schema.ts 的 "tools.approvalMode"）：always-ask 只自动
 * 放行只读、write 连写文件一起放行、yolo 全放行。产品这三颗按钮的语义正好落在
 * 同一个梯子上，所以是逐档对应，不是「近似」。
 *
 * 取值与 label 与 packages/conversation 的 permission-posture.ts 逐字一致 ——
 * 那一份是产品的取值域，这里是它在桥上的产地。
 */
const POSTURES: readonly {
  readonly value: string
  readonly label: string
  readonly mode: 'always-ask' | 'write' | 'yolo'
}[] = [
  { value: 'manual', label: '请求批准', mode: 'always-ask' },
  { value: 'yolo', label: '帮我批准', mode: 'write' },
  { value: 'auto', label: '完全访问权限', mode: 'yolo' },
]

/*
 * 上游的 auto 档位标记。
 *
 * 正本：@oh-my-pi/pi-tui 的 src/thinking.ts `export const AUTO_THINKING = "auto"`。
 * 它不是 Effort 也不是 ThinkingLevel（上游刻意把它留在 coding-agent 层之外，好让
 * 厂商映射只看见具体档位）。pi-tui 不在本包的依赖边上，所以照抄这个字面量。
 */
const AUTO_THINKING = 'auto'

/** 关掉思考那一档；上游的 ThinkingLevel.Off 就是这个词。 */
const OFF_THINKING = 'off'

/*
 * 上游给的档位说法：值 → 显示名与一句说明。
 *
 * 正本在读的时候从 settings-schema.ts 的 "defaultThinkingLevel".ui.options 取，
 * 不在代码里抄 —— 那一张表是上游自己维护的（它由 pi-tui 的
 * getConfiguredThinkingLevelMetadata 生成），我们抄一份就是第二个事实。
 *
 * 那一格也可能是字符串 "runtime"（选项由宿主在运行时给）。这一档我们拿不到，
 * 于是表为空，标签回落到档位值本身 —— 有说法就用说法，没有就把值写出来。
 */
const THINKING_OPTIONS: ReadonlyMap<string, { label: string; description?: string }> = new Map(
  ((): readonly { value: string; label: string; description?: string }[] => {
    const options = getUi('defaultThinkingLevel')?.options
    return Array.isArray(options) ? options : []
  })().map((option) => [
    option.value,
    {
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    },
  ]),
)

function currentSession(): Session | null {
  return active === null ? null : (sessions.get(active) ?? null)
}

/** 要求已经有一条会话；没有就是调用方的错，不是静默返回空。 */
function required(): Session {
  const record = currentSession()

  if (record === null) {
    throw new Error('no session')
  }

  return record
}

/**
 * 兑现一个等答复的对话框。
 *
 * 形状照上游的 extension_ui_response：`{ type, id, ...载荷 }`，桌按 id 找到那一条
 * 等待并 resolve 它。载荷的三种取值（value / confirmed / cancelled）由各自的对话
 * 框自己解释，这里不猜。
 */
function settleDialog(record: Session, requestId: string, payload: unknown): unknown {
  record.desk.settle(requestId, payload as Record<string, unknown>)

  return {}
}

/**
 * 把一批 ops 推给 Rust。
 *
 * 出去的不是裸的 ops 表，而是 `transcript.ops` 信封：Rust 那边原样转给
 * native-bridge，由它按 packages/transcript 钉住的形状校验（transcript-decoding.ts
 * 认的是 `{type, payload:{agent_id, seq, ops}}`）。信封与水位的产地在镜像那一处 ——
 * 推出去的和读回来的因此是同一份，不会一边带 seq 一边不带。
 */
function pushTranscript(record: Session, ops: readonly TranscriptOperation[]): void {
  if (ops.length === 0) {
    return
  }

  emit({
    kind: 'transcript',
    sessionId: record.id,
    payload: record.mirror.accept(ops),
  })
}

/**
 * 目标模式此刻的事实，从 omp 自己的会话状态读。
 *
 * 唯一的产地是 `session.getGoalModeState()`（agent-session.ts）—— 官方 TUI 的状态
 * 行与 `/goal show` 读的都是它。没有目标时它是 undefined，如实报 null。
 */
function readGoal(record: Session): GoalSnapshot | null {
  const state = record.agent.getGoalModeState()

  return state === undefined ? null : goalSnapshotOf(state.goal)
}

/**
 * omp 的一个目标 → 产品的形状。
 *
 * 两处折算，都是因为产品那一侧没有对应的格：
 *
 * - `budget-limited`（预算用尽、等加预算）正是产品说的受阻 `blocked`；
 * - `dropped`（用户清掉了目标）产品没有这一档，而它的意思就是「没有目标了」，
 *   所以报 null —— 折算成别的档会让灵动岛留着一条已经不存在的目标。
 *
 * `completionCriterion` 与 `turnsUsed` 在 omp 的目标里根本没有这两格，恒报
 * null / 0，不编一个看起来合理的值（ADR 0053：假数据比缺数据更坏）。
 */
function goalSnapshotOf(goal: GoalOfSession): GoalSnapshot | null {
  if (goal.status === 'dropped') {
    return null
  }

  return {
    objective: goal.objective,
    completionCriterion: null,
    status: goal.status === 'budget-limited' ? 'blocked' : goal.status,
    turnsUsed: 0,
    tokensUsed: goal.tokensUsed,
    wallClockMs: goal.timeUsedSeconds * 1000,
  }
}

/**
 * 换模型。
 *
 * `provider/id` 里 provider 自己可能带斜杠，所以只切第一段。找到就走上游的
 * `setModel`（它会校验凭据、重算思考档位、落一条 model_change 进会话），找不到
 * 如实报错 —— 静默什么都不做，界面会以为换成功了。
 */
async function selectModel(record: Session, value: string): Promise<void> {
  const [provider, ...rest] = value.split('/')
  const found = record.agent
    .getAvailableModels()
    .find((entry) => entry.provider === provider && entry.id === rest.join('/'))

  if (found === undefined) {
    throw new Error(`no model is available under ${value}`)
  }

  await record.agent.setModel(found)
  record.defaultModel = aliasOf(found)
}

/**
 * 换思考档位。
 *
 * 取值域是上游的 configured selector：`off` / `auto` / minimal..max。`setThinkingLevel`
 * 自己按当前模型的档位梯子夹取，也自己落一条 thinking_level_change 进会话 ——
 * 我们不预筛档位（预筛就是第二份梯子，模型的梯子只有它自己知道）。
 */
function selectThinking(record: Session, value: string): void {
  record.agent.setThinkingLevel(value as never)
}

/**
 * 换批准方式。
 *
 * 产品那三档与上游的 `tools.approvalMode` 逐档对应（见 POSTURES）。写的是 agent
 * 自己的设置层（Settings.set，它自己落盘并热重载），不是内存里的孤本 —— 人改一次
 * 就该留到下次开软件。flush 之后再报选择器：不 flush 的话磁盘上还是旧值，而屏幕
 * 上已经画了新值。
 */
async function selectPermission(record: Session, value: string): Promise<void> {
  const posture = POSTURES.find((entry) => entry.value === value)

  if (posture === undefined) {
    throw new Error(`no approval posture is called ${value}`)
  }

  record.settings.set('tools.approvalMode', posture.mode)
  await record.settings.flush()
}

/**
 * 把默认模型写进 agent 自己的 config.yml。
 *
 * 写的是 `modelRoles.default` —— omp 的模型角色表，它自己热重载。经 Settings 的
 * 持久层写（`setModelRole` 按角色合并，不会把并发的其它角色改动盖掉），不手搓
 * YAML：那是它的配置真身，格式归它。
 */
async function writeDefaultModel(modelId: string): Promise<void> {
  const settings = await settingsFor()
  settings.setModelRole('default', modelId)
  await settings.flush()
}

async function dispatch(command: BridgeCommand): Promise<unknown> {
  switch (command.type) {
    case 'new_session':
      return { sessionId: await openSession(command.cwd) }

    case 'prompt': {
      const record = required()
      pushTranscript(record, record.projector.userTurn(command.text))

      try {
        await record.agent.prompt(command.text)
      } catch (error) {
        /* 起不了一轮也要有轮终：Rust 侧靠它收账，不给就永远挂着一轮。 */
        const message = error instanceof Error ? error.message : String(error)
        pushTranscript(record, record.projector.turnEnd('failed', message))
        emit({ kind: 'turn_end', sessionId: record.id, outcome: 'failed', message })
        throw error
      }

      return {}
    }

    case 'cancel': {
      const record = required()
      await record.agent.abort()
      pushTranscript(record, record.projector.turnEnd('cancelled'))
      emit({ kind: 'turn_end', sessionId: record.id, outcome: 'cancelled' })
      return {}
    }

    case 'steer':
      await required().agent.steer(command.text)
      return {}

    /*
     * 一次授权答复。产品只有三颗按钮，而上游的 select 要一个标签 —— 翻一次，
     * 然后走与 answer_dialog 同一条兑现路（上游那份排队表按 id 认）。
     */
    case 'answer_permission': {
      const record = required()
      const label = labelFor({
        decision: command.decision,
        ...(command.scope === undefined ? {} : { scope: command.scope }),
      })

      return settleDialog(record, command.requestId, { value: label })
    }

    /* 别的对话框：原样转发上游的响应形状。 */
    case 'answer_dialog': {
      const record = required()

      return settleDialog(record, command.requestId, command.response)
    }
    case 'selectors':
      return { controls: await readSelectors(required()) }

    /* 目标：与选择器同一条读，只是单独问一次。没有目标如实回 null。 */
    case 'goal':
      return { goal: readGoal(required()) }

    /*
     * 屏幕经过的两条读。
     *
     * 正文是推的（`transcript` 事件），这两条只服务「打开一条会话要一页基线」与
     * 「断流后要一次追赶」—— 都由桥自己的镜像答，内容与推出去的那批逐字相同。
     */
    case 'transcript':
      return required().mirror.page(command.agentId)

    case 'transcript_ops':
      return required().mirror.catchUp(command.agentId, command.sinceSeq)

    case 'select': {
      const record = required()

      if (command.configId === 'model') {
        await selectModel(record, command.value)
      } else if (command.configId === 'thinking') {
        selectThinking(record, command.value)
      } else if (command.configId === 'permission') {
        await selectPermission(record, command.value)
      } else {
        /* 认不得的选择器如实拒绝：静默回一张没变的表，界面会以为改成功了。 */
        throw new Error(`no selector is called ${command.configId}`)
      }

      return { controls: await readSelectors(record) }
    }

    case 'sessions':
      return { sessions: [] }

    case 'skills':
      return { skills: [] }

    case 'mcp_servers':
      return { servers: [] }

    case 'model_catalog': {
      const record = required()

      return executeCatalog(
        command.operation,
        record.registry,
        record.authStorage,
        record.settings,
        record.defaultModel,
        {
          defaultModel: (modelId) => writeDefaultModel(modelId),
          /*
           * 走上游自己的写入面：`AuthStorage.set` 会替换该 provider 的整行凭据、
           * 刷新内存快照、重置它的凭据轮转，并落盘 agent.db。`source: 'login'` 是
           * 上游给「人自己填进来的钥匙」打的标记（auth-storage.ts 的 login 同款）。
           */
          apiKey: async (provider, apiKey) => {
            await record.authStorage.set(provider, {
              type: 'api_key',
              key: apiKey,
              source: 'login',
            })
          },
          /*
           * 删一个 provider：钥匙从 agent.db 删，定义从 models.yml 删，provider 停用。
           *
           * 停用那一格写的是 config.yml 的 `disabledProviders`，`settings.set` 自己
           * 落盘。删完要 flush：不 flush 的话磁盘上还是旧的停用表，而屏幕上已经少
           * 了一个 provider —— 下次开软件它又回来。
           */
          dropProvider: async (provider) => {
            await record.authStorage.remove(provider)
            await removeProvider(record.modelsFile, provider)
            disableProvider(provider)
            await record.settings.flush()
          },
          /*
           * 建或改一个 provider：写 agent 自己的 models.yml。
           *
           * SDK 只给了读者（`ModelsConfigFile` 没有 save），官方 TUI 是在交互界面里
           * 自己写这个文件的 —— 我们嵌的是 SDK，没有那个界面，所以这一格由我们补上
           * （见 models-file.ts 的头注释）。
           *
           * 写完要让注册表重读：`refresh()` 会 invalidate 配置缓存并按 mtime 重新载入
           * （model-registry.ts 的 `#reloadStaticModels`）。
           */
          defineProvider: async (provider, previousId) => {
            await writeProvider(record.modelsFile, provider, previousId)
          },
          /* 「从目录添加」里改了端点：只覆盖 baseUrl/api，不声明模型。 */
          overrideProvider: async (provider, baseUrl, api) => {
            await writeProviderOverride(record.modelsFile, { id: provider, baseUrl, api })
          },
          /*
           * 把一个 provider 从停用表里拿掉。
           *
           * `disabledProviders` 在凭据之前判（官方 providers.md 的「How omp decides a
           * provider is available」）：停用的 provider 就算有钥匙也一条模型都不出。
           * 所以「建/改/从目录添加」都要走这一步，否则「删除」写进去的停用标记永远
           * 盖着，人再配一次也回不来 —— 界面看上去就是「写了配置完全没反应」。
           *
           * 走官方那一条写入面（capability 的 enableProvider），它同时改全局层与落盘，
           * 并让注册表重算可用性。`settings.flush()` 是必须的：不 flush 的话磁盘上还是
           * 旧的停用表，而屏幕上已经多了一个 provider —— 下次开软件它又没了。
           */
          enableProvider: async (provider) => {
            enableProvider(provider)
            await record.settings.flush()
          },
        },
      )
    }

    case 'shutdown': {
      for (const record of sessions.values()) {
        record.unsubscribe?.()
        await record.agent.dispose()
      }
      sessions.clear()
      return {}
    }

    default:
      throw new Error(`unknown command: ${(command as { type: string }).type}`)
  }
}

async function main(): Promise<void> {
  write({
    type: 'ready',
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    agentVersion: '18.2.11',
  })

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')

      if (line === '') {
        continue
      }

      let command: BridgeCommand
      try {
        command = JSON.parse(line) as BridgeCommand
      } catch (error) {
        write({ type: 'failed', id: '', message: `malformed command: ${String(error)}` })
        continue
      }

      /*
       * 每条命令各跑各的，读循环不等它。
       *
       * 不能 await：一轮 prompt 会挂在一次授权对话框上，而那个答复正是下一条
       * 命令 —— 顺序处理就是「prompt 等对话框、对话框等答复、答复等 prompt」的
       * 死锁。应答按 id 配对，本来就不要求顺序。
       */
      void respond(command)
    }
  }
}

/** 跑一条命令，把结果或失败写成一行。 */
async function respond(command: BridgeCommand): Promise<void> {
  try {
    const data = await dispatch(command)
    write({ type: 'response', id: command.id, data })
  } catch (error) {
    write({
      type: 'failed',
      id: command.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

await main()
