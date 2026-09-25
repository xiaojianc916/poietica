// 桥的入口：omp SDK 编进进程，与 Rust 用 NDJSON 说话。
// 只做三件事：Rust 命令 → SDK 调用、SDK event → transcript ops、两者写一行 JSON 到 stdout。
// 落账/超时/取消重启归 Rust，这里不做第二套。

import path from 'node:path'
import type { AgentSession, AgentSessionEvent } from '@oh-my-pi/pi-coding-agent'
import {
  type AuthStorage,
  createAgentSession,
  discoverAuthStorage,
  getAgentDir,
  type MCPManager,
  ModelRegistry,
  SessionManager,
  Settings,
  VERSION,
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

// omp 的目标类型住在 pi-tui 里、不由 SDK 导出，从会话读法上取。
type GoalOfSession = NonNullable<ReturnType<AgentSession['getGoalModeState']>>['goal']

const emit = (event: BridgeEvent): void => {
  write({ type: 'event', event })
}

// 诊断走 stderr：stdout 是协议通道，多一个字都会毁掉那一行。
const log = (...parts: readonly unknown[]): void => {
  process.stderr.write(`${parts.map(String).join(' ')}\n`)
}

interface Session {
  readonly id: string
  readonly agent: AgentSession
  readonly projector: TranscriptProjector
  // 屏幕经过的镜像：ops 推出去的同时落进它，打开与追赶两条读从它答。
  readonly mirror: TranscriptMirror
  // 缺席即没开 MCP（restrictToolNames 强制关掉），不编空表。
  readonly mcp: MCPManager | undefined
  readonly registry: ModelRegistry
  readonly authStorage: AuthStorage
  readonly settings: Settings
  readonly modelsFile: string
  unsubscribe: (() => void) | null
  readonly desk: DialogDesk
  defaultModel: string | null
  planTools: readonly string[] | undefined
}

const sessions = new Map<string, Session>()
let active: string | null = null

// 设置走 omp 自己的持久层（受控 home 的 config.yml），不是内存孤本。
// 外来 provider 一律停用，走官方写入面（disableProvider → 全局层 + 落盘），不写运行时覆盖层：
// 覆盖层是整份替换数组，会把此刻读到的表钉死，用户之后启停 provider 都被盖住。
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
    initializeWithSettings(instance)

    // 已在表里的不重复写。
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

// omp 注册表每进程只有一个 "Main" 槽，并发初始化会互相顶掉。
let sessionInit: Promise<unknown> = Promise.resolve()

function queueInit<T>(work: () => Promise<T>): Promise<T> {
  const run = sessionInit.then(work, work)
  sessionInit = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function openSession(cwd: string): Promise<Session> {
  return queueInit(() => adopt(SessionManager.create(cwd), cwd))
}

function loadSession(sessionId: string, cwd: string): Promise<Session | null> {
  const held = sessions.get(sessionId)
  if (held !== undefined) {
    active = sessionId
    return Promise.resolve(held)
  }

  return queueInit(async () => {
    // 排到队首再看一眼：排队期间可能已有命令把这条会话装载进来。
    const loaded = sessions.get(sessionId)
    if (loaded !== undefined) {
      active = sessionId
      return loaded
    }

    const found =
      (await SessionManager.list(cwd)).find((entry) => entry.id === sessionId) ??
      (await SessionManager.listAll()).find((entry) => entry.id === sessionId)

    if (found === undefined) {
      log('no session file holds', sessionId)

      return null
    }

    return adopt(await SessionManager.open(found.path), cwd)
  })
}

// 新建与重装共用这一条：差别只有「管理器从哪来」，其余必须逐字相同。
async function adopt(manager: SessionManager, cwd: string): Promise<Session> {
  const authStorage = await discoverAuthStorage()
  const modelRegistry = new ModelRegistry(authStorage)
  await modelRegistry.refresh()

  // 号由我们签发。sessionId 先占空串：闸门可能在会话对象拿到号之前就被调到。
  let id = ''

  const desk = new DialogDesk((frame) => {
    emit({ kind: 'dialog_requested', sessionId: id, request: frame })
  })

  const { session, setToolUIContext, mcpManager } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settings: await settingsFor(),
    sessionManager: manager,
    // hasUI 必须 true，否则授权闸门 fail closed：非 yolo 下每次 write/exec 都抛 no interactive UI。
    hasUI: true,
  })

  id = session.sessionId ?? crypto.randomUUID()

  const record: Session = {
    id,
    agent: session,
    projector: new TranscriptProjector(),
    mirror: new TranscriptMirror(id),
    mcp: mcpManager,
    registry: modelRegistry,
    authStorage,
    settings: session.settings,
    modelsFile: path.join(getAgentDir(), 'models.yml'),
    unsubscribe: null,
    desk,
    defaultModel: session.model === undefined ? null : aliasOf(session.model),
    planTools: undefined,
  }

  const uiContext = createUIContext(desk)

  setToolUIContext(uiContext, true)

  // 两步缺一不可：setToolUIContext 只交给工具上下文；授权闸门读 runner.hasUI()，
  // runner 的 UI 由 initializeExtensions 装进去。只做第一步闸门仍 fail closed。
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

  if (record.agent.messages.length > 0) {
    replayHistory(record)
  }

  return record
}

// 按顺序喂给投影器（官方宿主回放历史同一条路）：用户消息开一轮，assistant 与工具结果落轮下。
function replayHistory(record: Session): void {
  const project = record.projector
  let endedAt: string | null = null

  for (const message of record.agent.messages) {
    if (message.role === 'user') {
      closeReplayedTurn(record, endedAt)
      pushTranscript(
        record,
        project.userTurn(textOf(message.content), [], undefined, iso(message.timestamp)),
      )
    } else if (message.role === 'assistant') {
      endedAt = iso(message.timestamp)
      replayAssistant(record, message.content)
    } else if (message.role === 'toolResult') {
      pushTranscript(
        record,
        project.toolEnd({
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          // details 必须带上：edit 路径与新旧正文、read 原始正文、todo 清单都在那里。
          result: { content: message.content, details: message.details },
          isError: message.isError,
        }),
      )
    }
  }

  closeReplayedTurn(record, endedAt)
}

function replayAssistant(record: Session, content: readonly ReplayBlock[]): void {
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      pushTranscript(record, record.projector.textDelta(block.text))
    } else if (block.type === 'thinking' && block.thinking) {
      pushTranscript(record, record.projector.thinkingDelta(block.thinking))
    } else if (block.type === 'toolCall' && block.id && block.name) {
      pushTranscript(
        record,
        record.projector.toolStart({
          toolCallId: block.id,
          toolName: block.name,
          args: block.arguments,
          ...(block.intent === undefined ? {} : { intent: block.intent }),
        }),
      )
    }
  }
}

function closeReplayedTurn(record: Session, endedAt: string | null): void {
  if (record.projector.isTurnOpen) {
    pushTranscript(record, record.projector.turnEnd('completed', undefined, endedAt ?? undefined))
  }
}

type ReplayBlock = {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly id?: string
  readonly name?: string
  readonly arguments?: Record<string, unknown>
  /* omp 让模型自己写的那句话；官方渲染器优先用它当那一行。 */
  readonly intent?: string
}

// 只有文本块上得了产品正文帧，图片块在会话媒体库里。
function textOf(content: string | { readonly type: string; readonly text?: string }[]): string {
  if (typeof content === 'string') {
    return content
  }

  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

const iso = (ms: number): string => new Date(ms).toISOString()

function handleEvent(record: Session, event: AgentSessionEvent): void {
  const project = record.projector
  let ops: ReturnType<TranscriptProjector['turnEnd']> = []
  // 轮终要等这批 ops 先落地：账上「这一轮结束了」不能早于「这一轮写了什么」。
  let ending: TurnOutcome | null = null

  switch (event.type) {
    case 'turn_start':
      // 用户那一轮由 prompt 命令开，这里只接 agent 自己的 turn。
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
        ...(event.intent === undefined ? {} : { intent: event.intent }),
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

    // 模型/思考档位换了，选择器那一栏变了。上游自己报事件，不是轮询。
    case 'model_changed':
    case 'thinking_level_changed':
      reselect(record)
      break

    case 'goal_updated':
      reselect(record)
      break

    case 'agent_end':
      // isTerminal 为 false 时后面还有活干，这一轮没真结束。
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

// 三格各有产地：model 用 session.model + getAvailableModels；
// thinking 候选是 off + auto + 模型支持档位（上游 cycleThinkingLevel 同顺序）；
// permission 对应 tools.approvalMode 三档。
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
      // 标签与说明取自上游自己的表（settings-schema 的 defaultThinkingLevel.ui.options）。
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

  // plan 由我们直接写会话状态（官方 ACP 宿主做法）；
  // goal 由 goalRuntime 建/收，且必须把 goal 工具塞回活动集（SDK 建会话时无条件摘掉它）。
  const plan = record.agent.getPlanModeState()

  if (record.settings.get('plan.enabled')) {
    controls.push({
      id: 'plan',
      label: '计划',
      purpose: 'mode',
      current: plan?.enabled === true ? 'on' : 'off',
      choices: [
        { value: 'on', label: '计划', detail: '先只读探查并给出计划，批准后再动手' },
        { value: 'off', label: '直接执行', detail: '不先出计划，直接动手' },
      ],
    })
  }

  if (record.settings.get('goal.enabled')) {
    const goal = record.agent.getGoalModeState()

    controls.push({
      id: 'goal',
      label: '目标',
      purpose: 'mode',
      current: goal?.enabled === true ? 'on' : 'off',
      choices: [
        { value: 'on', label: '目标', detail: '把它当作一个持续目标，达成前不中断' },
        { value: 'off', label: '不收目标', detail: '按普通一轮对话处理' },
      ],
    })
  }

  return controls
}

// 产品三档 → 上游 tools.approvalMode（always-ask/write/yolo），逐档对应。
// 取值与 label 与 packages/conversation 的 permission-posture.ts 逐字一致。
const POSTURES: readonly {
  readonly value: string
  readonly label: string
  readonly mode: 'always-ask' | 'write' | 'yolo'
}[] = [
  { value: 'manual', label: '请求批准', mode: 'always-ask' },
  { value: 'yolo', label: '帮我批准', mode: 'write' },
  { value: 'auto', label: '完全访问权限', mode: 'yolo' },
]

// 正本：pi-tui src/thinking.ts AUTO_THINKING = "auto"。pi-tui 不在依赖边，照抄字面量。
const AUTO_THINKING = 'auto'
const OFF_THINKING = 'off'

// 上游给的档位说法从 settings-schema 的 defaultThinkingLevel.ui.options 取，不在代码里抄。
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

function required(): Session {
  const record = currentSession()

  if (record === null) {
    throw new Error('no session')
  }

  return record
}

function settleDialog(record: Session, requestId: string, payload: unknown): unknown {
  record.desk.settle(requestId, payload as Record<string, unknown>)

  return {}
}

// 出去的是 transcript.ops 信封（Rust 原样转 native-bridge 校验），信封与水位的产地在镜像。
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

function readGoal(record: Session): GoalSnapshot | null {
  const state = record.agent.getGoalModeState()

  return state === undefined ? null : goalSnapshotOf(state.goal)
}

// budget-limited → blocked；dropped 产品没这档，报 null（折算成别的会留着已不存在的目标）。
// completionCriterion 与 turnsUsed omp 里没有，恒报 null/0，不编假值。
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

// provider/id 里 provider 自己可能带斜杠，只切第一段。
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

// setThinkingLevel 自己按当前模型档位梯子夹取，不预筛（预筛就是第二份梯子）。
function selectThinking(record: Session, value: string): void {
  record.agent.setThinkingLevel(value as never)
}

const GOAL_CONTROL_ID = 'goal'
const PLAN_CONTROL_ID = 'plan'

// 按 id 分派到自己的写法；认不得的 id 如实拒绝。
async function applySelection(
  record: Session,
  configId: string,
  value: string,
  input: string | null,
): Promise<void> {
  switch (configId) {
    case 'model':
      return await selectModel(record, value)
    case 'thinking':
      return selectThinking(record, value)
    case 'permission':
      return await selectPermission(record, value)
    case GOAL_CONTROL_ID:
      return await selectGoal(record, value, input)
    case PLAN_CONTROL_ID:
      return await selectPlan(record, value)
    default:
      throw new Error(`no selector is called ${configId}`)
  }
}

const DEFAULT_PLAN_FILE = 'local://PLAN.md'

// 三件事缺一不可（官方 TUI #enterGoalMode 是私有的，嵌入方照做）：
// 1. goalRuntime 建/收目标；2. 把 goal 工具塞回活动集（SDK 建会话时无条件摘掉它）；
// 3. setGoalModeState。
async function selectGoal(record: Session, value: string, input: string | null): Promise<void> {
  const runtime = record.agent.goalRuntime

  if (value === 'off') {
    await runtime.dropGoal()
    record.agent.setGoalModeState(undefined)

    return
  }

  const objective = input?.trim() ?? ''
  const existing = record.agent.getGoalModeState()

  if (!record.agent.hasBuiltInTool('goal')) {
    throw new Error('this agent has no goal tool')
  }

  // 先算活动工具集再落状态（与 TUI 同次序）；getEnabledToolNames 收整份活动集，在现有基础上加一个。
  const previous = record.agent.getEnabledToolNames().filter((name) => name !== 'goal')
  await record.agent.setActiveToolsByName([...new Set([...previous, 'goal'])])

  if (objective.length === 0 && existing?.goal.objective) {
    // 没有新正文就是「继续这个目标」。
    const state = existing.goal.status === 'paused' ? await runtime.resumeGoal() : existing
    record.agent.setGoalModeState(state)
  } else {
    if (objective.length === 0) {
      throw new Error('a goal needs an objective')
    }

    const created =
      existing === undefined
        ? await runtime.createGoal({ objective })
        : await runtime.replaceGoal({ objective })
    record.agent.setGoalModeState(created)
  }

  // 正在跑的会话里改目标：让模型立刻看见，不等下一轮。
  if (record.agent.isStreaming) {
    await record.agent.sendGoalModeContext({ deliverAs: 'steer' })
  }
}

// 进计划模式把活动工具收成只读组 + write（写计划文件要用）；出去时按进之前记下的还原。
async function selectPlan(record: Session, value: string): Promise<void> {
  if (!record.settings.get('plan.enabled')) {
    throw new Error('plan mode is disabled in this agent settings')
  }

  const state = record.agent.getPlanModeState()

  if (value === 'off') {
    const previous = record.planTools
    record.planTools = undefined

    record.agent.setPlanProposalHandler(null)
    record.agent.setPlanModeState(undefined)

    if (previous !== undefined) {
      await record.agent.setActiveToolsByName([...previous])
    }

    return
  }

  const active = record.agent.getEnabledToolNames()
  record.planTools ??= active

  // 状态必须先落再动工具集：上游按 planModeEnabled() 判 write 该不该留，
  // 次序反过来会让 write 在计算工具集时不被认成计划模式要用。
  record.agent.setPlanModeState({
    enabled: true,
    planFilePath: state?.planFilePath ?? DEFAULT_PLAN_FILE,
    workflow: state?.workflow ?? 'parallel',
    reentry: state !== undefined,
  })

  // 上游没把 bash/eval/task 收起来（tools/bash.ts 没读 plan 状态），嵌入方不摘「先别动手」就只是一句话。
  const readonly = active.filter((name) => !PLAN_MODE_STRIP.has(name))

  await record.agent.setActiveToolsByName(
    record.agent.hasBuiltInTool('write') ? [...new Set([...readonly, 'write'])] : readonly,
  )

  record.agent.setPlanProposalHandler((title) => proposePlan(record, title))

  if (record.agent.isStreaming) {
    await record.agent.sendPlanModeContext({ deliverAs: 'steer' })
  }
}

// 上游只挡 write/edit 对工作区的路，命令执行没这道闸，所以这一条是嵌入方责任。
const PLAN_MODE_STRIP: ReadonlySet<string> = new Set(['bash', 'eval', 'task'])

// 计划模式唯一被认可的收轮方式（系统提示明说不许用散文问批准，只用 write xd://propose）。
// 不装这个处理器那次 write 会抛「No plan is awaiting approval」，计划模式永远收不了尾。
// 批准暂时自动（官方 ACP 宿主对无表单界面客户端的做法）：这版还没有能答这个问题的界面。
async function proposePlan(record: Session, title: string): Promise<PlanReview> {
  const review = await record.agent.preparePlanForReview(title)
  const plan = review.details as PlanApproval | undefined

  if (plan === undefined) {
    return review
  }

  record.agent.setPlanReferencePath(plan.planFilePath)
  record.agent.setPlanProposalHandler(null)
  record.agent.setPlanModeState(undefined)

  const restore = record.planTools
  record.planTools = undefined

  if (restore !== undefined) {
    await record.agent.setActiveToolsByName([...restore])
  }

  return {
    content: [
      {
        type: 'text',
        text: `计划已确认：${plan.planFilePath}。按它执行。`,
      },
    ],
    details: plan,
  }
}

type PlanReview = Awaited<ReturnType<AgentSession['preparePlanForReview']>>

interface PlanApproval {
  readonly planFilePath: string
  readonly title: string
  readonly planExists: boolean
}

// 上游给 ${provider}:${level}，level 只有 user/project/native。
// 产品列是封闭五词，在这里折一次；认不出的落到 user。
function skillSourceOf(source: string): string {
  const level = source.slice(source.lastIndexOf(':') + 1)

  switch (level) {
    case 'native':
      return 'builtin'
    case 'project':
      return 'project'
    default:
      return 'user'
  }
}

function readServers(record: Session): readonly {
  readonly id: string
  readonly name: string
  readonly status: 'connected' | 'connecting' | 'disconnected' | 'error'
  readonly toolCount: number
  readonly lastError: string | null
}[] {
  const manager = record.mcp

  if (manager === undefined) {
    return []
  }

  return manager.getAllServerNames().map((name) => {
    const connection = manager.getConnection(name)

    return {
      id: name,
      name,
      status: manager.getConnectionStatus(name),
      toolCount: connection?.tools?.length ?? 0,
      lastError: null,
    }
  })
}

// 写 agent 自己的设置层（Settings.set 自己落盘并热重载），flush 后再报选择器。
async function selectPermission(record: Session, value: string): Promise<void> {
  const posture = POSTURES.find((entry) => entry.value === value)

  if (posture === undefined) {
    throw new Error(`no approval posture is called ${value}`)
  }

  record.settings.set('tools.approvalMode', posture.mode)
  await record.settings.flush()
}

// 写 modelRoles.default，omp 自己热重载。经 Settings 持久层写，不手搓 YAML。
async function writeDefaultModel(modelId: string): Promise<void> {
  const settings = await settingsFor()
  settings.setModelRole('default', modelId)
  await settings.flush()
}

function browserSettingsOf(settings: Settings): {
  enabled: boolean
  headless: boolean
  cdpUrl: string | null
} {
  const cdpUrl = settings.get('browser.cdpUrl')

  return {
    enabled: settings.get('browser.enabled') === true,
    headless: settings.get('browser.headless') === true,
    cdpUrl: typeof cdpUrl === 'string' && cdpUrl.trim() !== '' ? cdpUrl : null,
  }
}

async function dispatch(command: BridgeCommand): Promise<unknown> {
  switch (command.type) {
    case 'new_session': {
      const record = await openSession(command.cwd)
      return { sessionId: record.id, controls: readSelectors(record) }
    }

    case 'load_session': {
      const record = await loadSession(command.sessionId, command.cwd)

      return record === null
        ? { sessionId: null }
        : { sessionId: record.id, controls: readSelectors(record) }
    }

    case 'prompt': {
      const record = required()
      pushTranscript(record, record.projector.userTurn(command.text, [], command.promptId))

      try {
        await record.agent.prompt(command.text)
      } catch (error) {
        // 起不了一轮也要有轮终：Rust 侧靠它收账。
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

    // 产品只有三颗按钮，上游 select 要一个标签，翻一次后走与 answer_dialog 同一条路。
    case 'answer_permission': {
      const record = required()
      const label = labelFor({
        decision: command.decision,
        ...(command.scope === undefined ? {} : { scope: command.scope }),
      })

      return settleDialog(record, command.requestId, { value: label })
    }

    case 'answer_dialog': {
      const record = required()

      return settleDialog(record, command.requestId, command.response)
    }
    case 'selectors':
      return { controls: await readSelectors(required()) }

    case 'goal':
      return { goal: readGoal(required()) }

    // 屏幕经过两条读：打开会话要一页基线、断流后要一次追赶，都由镜像答。
    case 'transcript':
      return required().mirror.page(command.agentId)

    case 'transcript_ops':
      return required().mirror.catchUp(command.agentId, command.sinceSeq)

    case 'select': {
      const record = required()

      await applySelection(record, command.configId, command.value, command.input ?? null)

      return { controls: await readSelectors(record) }
    }

    case 'sessions':
      return { sessions: [] }

    case 'browser_settings':
      return { browser: browserSettingsOf(await settingsFor()) }

    case 'set_browser_settings': {
      const settings = await settingsFor()

      if (command.enabled !== undefined) {
        settings.set('browser.enabled', command.enabled)
      }
      if (command.headless !== undefined) {
        settings.set('browser.headless', command.headless)
      }
      if (command.cdpUrl !== undefined) {
        settings.set('browser.cdpUrl', command.cdpUrl)
      }

      await settings.flush()

      return { browser: browserSettingsOf(settings) }
    }

    // 桌面控制编译在构建里（tools/computer.ts + pi-natives），开与关是它自己的 computer.enabled 设置。
    case 'capabilities':
      return {
        capabilities: [
          {
            id: 'computer-use',
            pluginId: null,
            label: 'Computer use',
            supported: true,
            state: 'ready',
            install: { running: false, step: null, percent: null, error: null },
          },
        ],
      }

    // 产地是会话已装载的技能（session.skills），不再去盘上扫。
    case 'skills':
      return {
        skills: required().agent.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: skill.filePath,
          source: skillSourceOf(skill.source),
          kind: null,
          disableModelInvocation: skill.hide === true ? true : null,
        })),
      }

    // hasUI:true 时上游把 MCP 发现推迟到建会话后异步做，刚开完名册可能空。
    // 等一次在飞的握手，等待有上限。
    case 'mcp_servers': {
      const record = required()

      await record.mcp?.waitForPendingConnections()

      return { servers: readServers(record) }
    }

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
           * 走上游写入面：credentials.set 替换整行凭据、刷新快照、重置轮转、落盘
           * agent.db。18.3.0 把凭据那组方法搬进了 authStorage.credentials。
           */
          apiKey: async (provider, apiKey) => {
            await record.authStorage.credentials.set(provider, {
              type: 'api_key',
              key: apiKey,
              source: 'login',
            })
          },
          // 删 provider：钥匙从 agent.db 删，定义从 models.yml 删，provider 停用，flush。
          dropProvider: async (provider) => {
            await record.authStorage.credentials.remove(provider)
            await removeProvider(record.modelsFile, provider)
            disableProvider(provider)
            await record.settings.flush()
          },
          // SDK 只给了读者（ModelsConfigFile 没有 save），这一格由我们补上（见 models-file.ts）。
          defineProvider: async (provider, previousId) => {
            await writeProvider(record.modelsFile, provider, previousId)
          },
          overrideProvider: async (provider, baseUrl, api) => {
            await writeProviderOverride(record.modelsFile, { id: provider, baseUrl, api })
          },
          // disabledProviders 在凭据之前判：停用的 provider 就算有钥匙也不出模型。
          // 走官方 enableProvider（改全局层 + 落盘 + 注册表重算），flush 必须。
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
    agentVersion: VERSION,
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

      // 不能 await：一轮 prompt 会挂在授权对话框上，而答复正是下一条命令，顺序处理会死锁。
      void respond(command)
    }
  }
}

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
