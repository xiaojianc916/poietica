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
  type MCPManager,
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
  /**
   * MCP 管理器：`createAgentSession` 的结果给的，不在会话对象上。
   *
   * 它缺席就是这条会话没开 MCP（`restrictToolNames` 会强制关掉）。缺席即不报名册，
   * 不编一个空表 —— 空表与「一个都没连上」在屏幕上分不出来。
   */
  readonly mcp: MCPManager | undefined
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
  /** 进计划模式之前的活动工具集；出来时照它还原。没进过就是 undefined。 */
  planTools: readonly string[] | undefined
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

/*
 * 会话初始化串行排队：omp 的注册表每进程只有一个 "Main" 槽，两次
 * createAgentSession 并发初始化会互相顶掉（replaced during initialization）。
 */
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

/**
 * 重装一条以前开过的会话：先扫对话工作区的桶，miss 再全桶按 id 找（旧会话可能
 * 落在别的 cwd 桶里）。连接已持有这条会话时只拨回 active。找不到回 null，不是
 * 链路错误。
 */
function loadSession(sessionId: string, cwd: string): Promise<Session | null> {
  const held = sessions.get(sessionId)
  if (held !== undefined) {
    active = sessionId
    return Promise.resolve(held)
  }

  return queueInit(async () => {
    /* 排到队首再看一眼：排队期间可能已经有命令把这条会话装载进来了。 */
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

/**
 * 用一条会话管理器建起会话、接上 UI 与扩展、登记进表。
 *
 * 新建与重装共用这一条：两边的差别只有「管理器从哪来」，其余（对话框、授权闸门、
 * 事件订阅）必须逐字相同 —— 分成两份就会一边修好一边没修。
 */
async function adopt(manager: SessionManager, cwd: string): Promise<Session> {
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

  const { session, setToolUIContext, mcpManager } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settings: await settingsFor(),
    sessionManager: manager,
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
    mcp: mcpManager,
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
    planTools: undefined,
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

  /* 重装进来的会话把历史投进镜像；新建会话没有消息，空转。 */
  if (record.agent.messages.length > 0) {
    replayHistory(record)
  }

  return record
}

/**
 * 把恢复出来的历史按顺序喂给投影器（官方宿主回放历史的同一条路）：一条用户
 * 消息开一轮，assistant 与工具结果落轮下，下一条用户消息先收上一轮。时间戳
 * 用消息自带的。投影器只有一套，历史与直播同形。
 */
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
          /* 与直播的 tool_execution_end 同形（AgentToolResult 的 content 那一格）。 */
          result: { content: message.content },
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

/** 历史消息的内容块；这里只认这几种，其余（图片等）如实跳过。 */
type ReplayBlock = {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly id?: string
  readonly name?: string
  readonly arguments?: Record<string, unknown>
}

/** 用户消息的正文：只有文本块上得了产品的正文帧，图片块在会话媒体库里。 */
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

  /*
   * 两个模式开关。
   *
   * 产品的取值域是 on/off 两档（session-controls.tsx 的 isToggleControl 就是这么认
   * 的），所以这里报两档，current 由会话自己此刻的状态算。
   *
   * 两格的开关方式不同，各自有出处：
   *
   * - plan 由我们直接写会话状态（`setPlanModeState` + 重算活动工具集），这是官方
   *   ACP 宿主 acp-agent.ts 的做法 —— 官方 TUI 的 `#enterPlanMode` 是私有的，嵌
   *   入方只能照 ACP 那条路自己拼。
   * - goal 由 `goalRuntime` 建/收目标，并且必须把 `goal` 工具塞回活动集：SDK 建
   *   会话时无条件把它摘掉（sdk.ts 的 `filter(name => name !== "goal")`），不塞回
   *   去模型就叫不动它。
   */
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

/*
 * 两个模式开关在会话控件里的 id。正本在 packages/conversation：
 * surface/goal/goal-control.ts 的 GOAL_CONTROL_ID，以及 composer-actions 认的
 * 'plan'。这里照抄字面量，因为那一份不在本包的依赖边上。
 */
const GOAL_CONTROL_ID = 'goal'
const PLAN_CONTROL_ID = 'plan'

/**
 * 一次选择器写入：按 id 分派到它自己的写法。
 *
 * 分派收在这里而不是摊在 dispatch 里：那一个 switch 已经很大，而这几条各有各的
 * 语义（有的写设置、有的写会话状态、有的连工具集一起动），混进命令分派里两件事
 * 就搅在一起了。
 *
 * 认不得的 id 如实拒绝：静默回一张没变的表，界面会以为改成功了。
 */
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

/** 计划文件的正本名；与 plan-mode/plan-protection.ts 的 PLAN_FILE_URL 同一个值。 */
const DEFAULT_PLAN_FILE = 'local://PLAN.md'

/**
 * 开关目标模式。
 *
 * 三件事缺一不可，这是官方 TUI 的 `#enterGoalMode`（interactive-mode.ts）做的事，
 * 它自己是私有的，所以嵌入方照做：
 *
 * 1. `goalRuntime.createGoal` / `dropGoal` 建或收目标 —— 记账（token、墙钟、预算
 *    翻转）全在 runtime 里，会话自己挂的钩子，我们不用管。
 * 2. 把 `goal` 工具塞回活动集。**这一步不能省**：SDK 建会话时无条件把它摘掉
 *    （sdk.ts 的 `filter(name => name !== "goal")`），不塞回去模型根本叫不动它，
 *    目标就只是一个没人执行的标志位。
 * 3. 目标是「正在跑的会话」的状态，所以要 `setGoalModeState`。
 *
 * objective 从 `input` 来：产品的目标栏把那句话当目标正文交上来。没有正文时用
 * 这一轮的话本身（跟 TUI 的 `/goal <text>` 一个意思）—— 空目标建不出来，
 * runtime 会拒。
 */
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
    /* 这一版没编进 goal 工具（`goal.enabled` 关着，或档案限制了工具集）：如实说。 */
    throw new Error('this agent has no goal tool')
  }

  /*
   * 先把活动工具集算好，再落状态 —— 与 TUI 的 `#enterGoalMode` 同一个次序
   * （interactive-mode.ts：先 `setActiveToolsByName`，后 `setGoalModeState`）。
   *
   * `getEnabledToolNames` 是上游给的读法，收的是**整份**活动集，所以在现有基础上
   * 加一个，不能只传这一个 —— 只传它会把别的工具全关掉。
   */
  const previous = record.agent.getEnabledToolNames().filter((name) => name !== 'goal')
  await record.agent.setActiveToolsByName([...new Set([...previous, 'goal'])])

  if (objective.length === 0 && existing?.goal.objective) {
    /* 没有新正文就是「继续这个目标」：恢复它，不拿空串覆掉原来的。 */
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

  /* 正在跑的会话里改目标：让模型立刻看见新的目标上下文，不等下一轮。 */
  if (record.agent.isStreaming) {
    await record.agent.sendGoalModeContext({ deliverAs: 'steer' })
  }
}

/**
 * 开关计划模式。
 *
 * 官方 TUI 的 `#enterPlanMode` 是私有的，能用的公开面只有 `setPlanModeState` 与
 * `setActiveToolsByName`；官方自己的 ACP 宿主（modes/acp/acp-agent.ts）就是这么
 * 拼的，这里照它做。
 *
 * 进计划模式时把活动工具收成只读那一组：计划模式的语义就是「先别动手」。`write`
 * 是例外 —— 模型要把计划写进那个计划文件（plan-mode 的 plan-protection 只放行
 * 计划文件本身的写），不收它计划就落不了盘。
 *
 * 出去时按进之前记下的那一份还原，不猜默认值。
 */
async function selectPlan(record: Session, value: string): Promise<void> {
  if (!record.settings.get('plan.enabled')) {
    throw new Error('plan mode is disabled in this agent settings')
  }

  const state = record.agent.getPlanModeState()

  if (value === 'off') {
    const previous = record.planTools
    record.planTools = undefined

    /* 收摊的次序与 TUI 一致：先摘处理器，再落状态，最后还原工具集。 */
    record.agent.setPlanProposalHandler(null)
    record.agent.setPlanModeState(undefined)

    if (previous !== undefined) {
      await record.agent.setActiveToolsByName([...previous])
    }

    return
  }

  const active = record.agent.getEnabledToolNames()
  record.planTools ??= active

  /*
   * 状态必须先落，再动工具集。
   *
   * 上游按 `planModeEnabled()` 判 `write` 该不该留在直连面上（session-tools.ts 的
   * `transportNeeded`），而计划批准本身就是一次 `write xd://propose`。次序反过来
   * 会让 `write` 在计算工具集那一刻还没被认成「计划模式要用」，于是模型既写不了
   * 计划文件、也提交不了计划 —— 卡在那里烧完三次提醒然后停住。
   */
  record.agent.setPlanModeState({
    enabled: true,
    planFilePath: state?.planFilePath ?? DEFAULT_PLAN_FILE,
    workflow: state?.workflow ?? 'parallel',
    reentry: state !== undefined,
  })

  /*
   * 只留只读那些，外加写计划文件要用的 write；`bash`/`eval`/`task` 由我们摘掉。
   *
   * 上游**没有**把它们收起来（tools/bash.ts 里一处都没有读 plan 状态），只靠系统
   * 提示叫模型别提交、别装依赖。嵌入方不摘，计划模式的「先别动手」就只是一句话。
   */
  const readonly = active.filter((name) => !PLAN_MODE_STRIP.has(name))

  await record.agent.setActiveToolsByName(
    record.agent.hasBuiltInTool('write') ? [...new Set([...readonly, 'write'])] : readonly,
  )

  record.agent.setPlanProposalHandler((title) => proposePlan(record, title))

  if (record.agent.isStreaming) {
    await record.agent.sendPlanModeContext({ deliverAs: 'steer' })
  }
}

/**
 * 计划模式下要收掉的写工具：它们动手改的是用户的工程，不只是计划文件。
 *
 * 上游只挡 `write`/`edit` 对工作区的那条路（tools/plan-mode-guard.ts 的
 * `enforcePlanModeWrite`），命令执行没有这道闸 —— 所以这一条是嵌入方的责任。
 */
const PLAN_MODE_STRIP: ReadonlySet<string> = new Set(['bash', 'eval', 'task'])

/**
 * 模型把计划交上来等批准。
 *
 * 这是计划模式唯一被认可的收轮方式（系统提示 plan-mode-active.md 明说「不许用
 * 散文问批准，只用 `write xd://propose`」）。不装这个处理器，那次 write 会直接抛
 * 「No plan is awaiting approval」—— 计划模式因此永远收不了尾，模型烧完三次提醒
 * 然后停住（上游 issue #1869）。
 *
 * **批准暂时是自动的**，照官方 ACP 宿主对「没有表单界面的客户端」的做法
 * （acp-agent.ts：「auto-approve so plan mode is never stranded」）。理由是这一版
 * 还没有能答这个问题的界面：桥把对话框推成 `dialog` 事件，而屏幕上没有一处订阅它，
 * 问出去就是一个永远等不到的回答。计划本身照样看得见 —— 模型是用 `write` 写的计划
 * 文件，那次工具调用就在转录里。
 *
 * 要变成真的「人批准才动手」，得先在界面上接一条批准路（订阅 dialog 事件、把计划
 * 摊开给人看），再把这里换回 `record.desk.ask`。在那之前按自动批准走，不假装有人
 * 在把关。
 */
async function proposePlan(record: Session, title: string): Promise<PlanReview> {
  const review = await record.agent.preparePlanForReview(title)
  const plan = review.details as PlanApproval | undefined

  if (plan === undefined) {
    return review
  }

  /* 批准：记下这份计划、摘掉处理器、退出计划模式、把工具集还回去。 */
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

/*
 * 计划处理器交回的那一份。形状直接取自官方那一步的返回类型
 * （`session.preparePlanForReview` 的 `AgentToolResult`）—— 手抄一遍就是第二个
 * 事实，上游改了这里不会跟着编译错。
 */
type PlanReview = Awaited<ReturnType<AgentSession['preparePlanForReview']>>

/** `preparePlanForReview` 交回的那几格。 */
interface PlanApproval {
  readonly planFilePath: string
  readonly title: string
  readonly planExists: boolean
}

/**
 * omp 的技能来源 → 产品那一列的词。
 *
 * 上游给的是 `${provider}:${level}`（extensibility/skills.ts 的
 * `source: \`${capSkill._source.provider}:${capSkill.level}\``），level 只有
 * user / project / native 三种（capability/types.ts 的 SourceMeta）。
 *
 * 产品那一列是封闭的五个词：内置 / 本机 / 项目 / 用户 / 额外
 * （settings/ui/skills-settings.tsx 的 SOURCE_LABELS）。公开在屏幕上的只能是这
 * 五个，所以在这里折一次。'native' 是上游自己编进包里的那些，就是产品的「内置」。
 *
 * 认不出的来源落到 'user'：技能的正文与开关都照旧能用，只是分组那一格说得笼统
 * 一点 —— 比编一个不存在的来源好。
 */
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

/**
 * MCP 名册。
 *
 * 状态与工具数各有出处（manager.ts）：状态读 `getConnectionStatus`，工具数读连接
 * 自己的 `tools` 表 —— 上游自己的命令控制器就是这么取的。
 *
 * 上游没有逐服务器的错误格，只有连接失败事件里那一条，所以 `lastError` 如实报
 * null，不编一句错误文案。缺席（这条会话没开 MCP）就是空名册。
 */
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

/** omp 的浏览器控制设置 → 产品的形状；cdpUrl 空串与未设都算「托管启动」。 */
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

      await applySelection(record, command.configId, command.value, command.input ?? null)

      return { controls: await readSelectors(record) }
    }

    case 'sessions':
      return { sessions: [] }

    /*
     * 浏览器控制设置。omp 的浏览器是内置能力（Puppeteer 驱动 Chromium）：开与关、
     * 有头无头、附着到现成 CDP 端点还是自己拉一个，都是它自己的设置。写走官方
     * 写入面并 flush，与磁盘上那份逐字一致。
     */
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

    /*
     * agent 自己提供的能力清单。
     *
     * omp 的桌面控制编译在这个构建里（tools/computer.ts + pi-natives），开与关是它
     * 自己的 `computer.enabled` 设置 —— 所以 supported 恒真、报 ready、不带插件；
     * 安装与修复两条路对它不存在。这是构建事实，与任何一条会话无关。
     */
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

    /*
     * 技能名册。
     *
     * 产地是会话自己那份已装载的技能（`session.skills`），不是我们再去盘上扫一遍
     * —— 官方 TUI 的技能页读的也是它（`AgentSession.skills`，agent-session.ts）。
     * 再扫一遍就是第二个产地：扫出来的东西可能根本没被这条会话装载。
     *
     * source 折成产品那五个词（见 skillSourceOf）：产品那一列是封闭取值域，把
     * 上游的 `provider:level` 原样画上去，人是读不懂的。
     */
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

    /*
     * MCP 名册。
     *
     * 管理器是 `createAgentSession` 的结果给的，不在会话对象上。状态与工具数各有
     * 出处：状态读 `getConnectionStatus`，工具数读连接自己的 `tools` 表 —— 上游
     * TUI 的命令控制器就是这么取的。上游没有逐服务器的错误字段，只有连接失败事件
     * 里那一句，所以这里如实报 null，不编一条错误文案。
     *
     * `hasUI: true` 时上游把发现**推迟**到建会话之后异步做（sdk.ts 的
     * `deferMCPDiscoveryForUI`），所以刚开完会话那一刻名册可能还是空的 —— 那是
     * 「还在连」，不是「一台都没有」。这里等一次在飞的握手，让人打开面板时看得到
     * 真名册；等待有上限，连不上的服务器不该把人挡在这里。
     */
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
