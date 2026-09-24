/*
 * 桥的入口：omp SDK 编进这个进程，与 Rust 用 NDJSON 说话。
 *
 * 它只有三件事：把 Rust 的命令翻成 SDK 调用、把 SDK 的 typed event 投影成
 * transcript ops、把两者都写成一行 JSON 到 stdout。落账、超时、取消的重启
 * 都归 Rust —— 这里不做第二套（AGENTS.md §5）。
 *
 * 这个文件被 tools/agent/build-bridge.ts 编成单文件可执行，用户不需要装 omp。
 */

import type { AgentSession, AgentSessionEvent } from '@oh-my-pi/pi-coding-agent'
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from '@oh-my-pi/pi-coding-agent'
import { RpcPendingExtensionRequests } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import { createUIContext, labelFor } from './approval.ts'
import { aliasOf, executeCatalog } from './catalog.ts'
import { TranscriptProjector } from './projection.ts'
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeFrame,
  type SelectorControl,
  type UsageSnapshot,
} from './protocol.ts'

const write = (frame: BridgeFrame): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

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
  /** 模型目录读的是它；每一条会话自己那份注册表。 */
  readonly registry: ModelRegistry
  unsubscribe: (() => void) | null
  /** 等答复的对话框，上游那份排队表。 */
  readonly pending: RpcPendingExtensionRequests
  /** 用户在这条会话里选过的默认模型；目录那一页读它。 */
  defaultModel: string | null
}

const sessions = new Map<string, Session>()
let active: string | null = null

/*
 * 设置走 omp 自己的持久层（受控 home 的 config.yml），不是内存里的孤本。
 *
 * 用户的模型角色、审批模式都住在那里，omp 自己热重载它。我们只在上面盖一条
 * 运行时覆盖：omp 首次运行会去读用户磁盘上的 .claude/.codex/…，那是别人的配置，
 * 不是我们的 —— 覆盖不落盘，所以不会把用户自己的 config.yml 改掉。
 */
let settingsPromise: Promise<Settings> | null = null

function settingsFor(): Promise<Settings> {
  settingsPromise ??= Settings.init().then((instance) => {
    instance.override('disabledProviders', [
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
    ])

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
   * 授权闸门要一个能给出行外答复的人。答复从 Rust 那条路回来（answer_permission），
   * 所以这里先占一个 Promise，等答复到了再兑现。
   *
   * sessionId 先占好：闸门可能在会话对象拿到号之前就被调到（上游在建会话时就装
   * 好了包装器），闭包里读一个还没赋值的 id 会推出去一个 undefined。
   */
  /*
   * 对话框走上游自己的那套：请求排队在 pending 里，写成帧发出去，答复从
   * answer_dialog 那条命令回来兑现。上游的 request* 帮手替我们处理了超时、
   * 取消与响应配对。
   */
  const pending = new RpcPendingExtensionRequests()

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

  const id = session.sessionId ?? crypto.randomUUID()
  const record: Session = {
    id,
    agent: session,
    projector: new TranscriptProjector(),
    registry: modelRegistry,
    unsubscribe: null,
    pending,
    defaultModel: session.model === undefined ? null : aliasOf(session.model),
  }

  const uiContext = createUIContext(pending, (frame) => {
    emit({ kind: 'dialog_requested', sessionId: id, request: frame })
  })

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
    controls: readSelectors(session),
  })

  return id
}

function handleEvent(record: Session, event: AgentSessionEvent): void {
  const project = record.projector
  let ops: ReturnType<TranscriptProjector['turnEnd']> = []
  /* 轮终要等这一批 ops 先落地：账上「这一轮结束了」不能早于「这一轮写了什么」。 */
  let ending: 'completed' | null = null

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

    case 'agent_end':
      /* isTerminal 为 false 时后面还有活干，这一轮没真结束。 */
      if (event.isTerminal !== false) {
        ops = project.turnEnd('completed')
        ending = 'completed'
      }
      break

    default:
      break
  }

  if (ops.length > 0) {
    emit({ kind: 'transcript', sessionId: record.id, payload: { agentId: 'main', ops } })
  }

  if (ending !== null) {
    emit({ kind: 'turn_end', sessionId: record.id, outcome: ending })
    reportUsage(record)
  }
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

function readSelectors(session: AgentSession): SelectorControl[] {
  const controls: SelectorControl[] = []
  const model = session.model

  if (model !== undefined) {
    const available = session.getAvailableModels?.() ?? []
    controls.push({
      id: 'model',
      purpose: 'model',
      current: `${model.provider}/${model.id}`,
      choices: available.map((entry) => ({
        value: `${entry.provider}/${entry.id}`,
        label: entry.name ?? entry.id,
      })),
    })
  }

  const levels = session.getAvailableThinkingLevels?.() ?? []
  if (levels.length > 0) {
    controls.push({
      id: 'thinking',
      purpose: 'thinking',
      current: session.thinkingLevel ?? 'off',
      choices: levels.map((level) => ({ value: level, label: level })),
    })
  }

  return controls
}

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
 * 形状照上游的 RpcExtensionUIResponse：`{ type, id, ...载荷 }`，上游按 id 找到
 * 那一条 pending 并 resolve 它。载荷的三种取值（value / confirmed / cancelled）
 * 由各自的对话框自己解释，这里不猜。
 */
function settleDialog(record: Session, requestId: string, payload: unknown): unknown {
  const pending = record.pending.get(requestId)

  if (pending === undefined) {
    /* 已经答过、或这一轮已经不在等了。如实说没有，不假装答上了。 */
    throw new Error(`no dialog is waiting under ${requestId}`)
  }

  pending.resolve({
    type: 'extension_ui_response',
    id: requestId,
    ...(payload as Record<string, unknown>),
  } as never)

  return {}
}

function pushTranscript(record: Session, ops: readonly unknown[]): void {
  if (ops.length === 0) {
    return
  }

  emit({ kind: 'transcript', sessionId: record.id, payload: { agentId: 'main', ops } })
}

/** 换模型：`provider/id` 里 provider 自己可能带斜杠，所以只切第一段。 */
async function selectModel(record: Session, value: string): Promise<void> {
  const [provider, ...rest] = value.split('/')
  const found = record.agent
    .getAvailableModels()
    .find((entry) => entry.provider === provider && entry.id === rest.join('/'))

  if (found !== undefined) {
    await record.agent.setModel(found)
    record.defaultModel = aliasOf(found)
  }
}

/**
 * 把默认模型写进 agent 自己的 config.yml。
 *
 * 写的是 `modelRoles.default` —— omp 的模型角色表，它自己热重载。经 Settings 的
 * 持久层写，不手搓 YAML：那是它的配置真身，格式归它。
 */
async function writeDefaultModel(modelId: string): Promise<void> {
  const settings = await settingsFor()
  settings.set('modelRoles', { ...settings.get('modelRoles'), default: modelId })
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
      return { controls: readSelectors(required().agent) }

    case 'select': {
      const record = required()

      if (command.configId === 'model') {
        await selectModel(record, command.value)
      } else if (command.configId === 'thinking') {
        record.agent.setThinkingLevel(command.value as never)
      }

      return { controls: readSelectors(record.agent) }
    }

    case 'sessions':
      return { sessions: [] }

    case 'skills':
      return { skills: [] }

    case 'mcp_servers':
      return { servers: [] }

    case 'model_catalog': {
      const record = required()

      return executeCatalog(command.operation, record.registry, record.defaultModel, (modelId) =>
        writeDefaultModel(modelId),
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
