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

/** 一条会话。多会话并发是常态，所以这里是一张表而不是一个当前值。 */
interface Session {
  readonly id: string
  readonly agent: AgentSession
  readonly projector: TranscriptProjector
  unsubscribe: (() => void) | null
}

const sessions = new Map<string, Session>()
let active: string | null = null

const settings = Settings.isolated({
  /* omp 首次运行会去读用户磁盘上的 .claude/.codex/…；那是别人的配置，不是我们的。 */
  disabledProviders: [
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
  ],
})

async function openSession(cwd: string): Promise<string> {
  const authStorage = await discoverAuthStorage()
  const modelRegistry = new ModelRegistry(authStorage)
  await modelRegistry.refresh()

  const { session } = await createAgentSession({
    cwd,
    authStorage,
    modelRegistry,
    settings,
    sessionManager: SessionManager.create(cwd),
    hasUI: false,
  })

  const id = session.sessionId ?? crypto.randomUUID()
  const record: Session = {
    id,
    agent: session,
    projector: new TranscriptProjector(),
    unsubscribe: null,
  }

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
        emit({
          kind: 'turn_end',
          sessionId: record.id,
          outcome: 'completed',
        })
        reportUsage(record)
      }
      break

    default:
      break
  }

  if (ops.length > 0) {
    emit({ kind: 'transcript', sessionId: record.id, payload: { agentId: 'main', ops } })
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
  }
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
  }
}

await main()
