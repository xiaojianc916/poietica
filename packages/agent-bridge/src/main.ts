// 桥的入口：omp SDK 编进进程，与 Rust 用 NDJSON 说话。
// 只做三件事：Rust 命令 → SDK 调用、SDK event → transcript ops、两者写一行 JSON 到 stdout。
// 落账/超时/取消重启归 Rust，这里不做第二套。

import fs from 'node:fs'
import path from 'node:path'
import type { AgentSession, AgentSessionEvent } from '@oh-my-pi/pi-coding-agent'
import {
  type AuthStorage,
  createAgentSession,
  discoverAuthStorage,
  FileSessionStorage,
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
import { exportFromFile } from '@oh-my-pi/pi-coding-agent/export/html'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import type { TranscriptOperation } from '@poietica/transcript'
import {
  APPROVAL_OPTIONS,
  approvalDetailOf,
  approvalToolOf,
  createUIContext,
  DialogDesk,
  type DialogLifecycle,
  labelFor,
  responseOf,
  type UpstreamDialogRequest,
} from './approval.ts'
import { aliasOf, executeCatalog } from './catalog.ts'
import { removeProvider, writeProvider, writeProviderOverride } from './models-file.ts'
import { outcomeOf, type TurnOutcome } from './outcome.ts'
import { attachmentOp, interactionOp, markerOp, TranscriptProjector } from './projection.ts'
import {
  type AskedQuestion,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeFrame,
  type GoalSnapshot,
  type SelectorControl,
  type UsageSnapshot,
} from './protocol.ts'
import { answerPayloadOf, askQuestionsOf } from './questions.ts'
import { readCatalog, SETTING_TABS } from './settings.ts'
import { tabLabelOf } from './settings-labels.ts'
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
  /*
   * 在等人答的那几件：号 → 那一件是什么。
   *
   * 屏幕要画「有一件事在等人答」，而那条事实只有这里知道 —— Rust 那边的 PermissionDesk
   * 是另一条路上的会合点，它不认识「这是第几号、是哪件工具」。答完就删，不留痕迹
   * （ADR 0015：答复之后什么都不留）。
   */
  readonly pending: Map<string, PendingInteraction>
  /** ask 工具那组题的号 → 题组；答复翻译要用它把号换回标签。 */
  readonly asked: Map<string, readonly AskedQuestion[]>
  /** 本次会话已允许的工具（scope=session 的产物），免得重复写同一格设置。 */
  readonly allowed: Set<string>
  /*
   * 正在压的那一次压缩的号与已发出的那几格。
   *
   * 压缩是「开门 → 关门」两件事，而 omp 的关门事件不带开门的号；号要我们自己记，
   * 否则关上门会在屏幕上多出一行而不是把原来那行改掉。关门即清。
   */
  compacting: { readonly markerId: string } | null
  /** 压缩次数：只用来给新的一次起号，不参与显示。 */
  compactions: number
}

interface PendingInteraction {
  readonly kind: 'approval' | 'question'
  /** 授权那一类用它做设置键（会话级放行）与屏幕上的说法；题组恒为 'ask'。 */
  readonly toolName: string
  readonly request: UpstreamDialogRequest
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

/*
 * 会话号 → 会话文件路径。
 *
 * 删除与导出都要的是路径（上游那两个接口收的都是路径，不是号），而号是我们这边的东西
 * 唯一的键。先按这条连接的工作区找，再全量找 —— 与 loadSession 同一个次序：
 * 会话可能属于另一个工作区，只看当前目录会漏。
 */
async function findSessionFile(
  sessionId: string,
  manager: SessionManager | undefined,
): Promise<string | undefined> {
  const loaded = manager?.getSessionFile()

  if (manager !== undefined && manager.getSessionId() === sessionId && loaded !== undefined) {
    return loaded
  }

  return (
    (await SessionManager.list(manager?.getCwd() ?? process.cwd())).find(
      (entry) => entry.id === sessionId,
    )?.path ?? (await SessionManager.listAll()).find((entry) => entry.id === sessionId)?.path
  )
}

/*
 * 从某一轮分叉。
 *
 * 上游没有「丢 N 轮再复制」这一个动作，得自己拼：
 * - `dropTurns === 0`：整份复制，`AgentSession#fork()`（它整份克隆并重锚）。
 * - `dropTurns > 0`：`AgentSession#branch(entryId)` —— 它按 `createBranchedSession`
 *   截到那一条之前，再把会话重锚（id 同步、消息替换、记忆重键、bash 过渡都在里面）。
 *
 * `branch()` 只认 user 消息那一条作锚（agent-session.ts:10069），所以「丢 N 轮」
 * 就是把锚定在倒数第 N 条 user 消息上。
 *
 * **这一步会把这条连接移到新会话上**（新号、新文件），所以回来之后要重新记账，
 * 否则之后用旧号说话会打到新会话上。
 */
async function forkSession(
  record: Session,
  command: Extract<BridgeCommand, { type: 'fork_session' }>,
): Promise<unknown> {
  if (record.id !== command.sessionId) {
    throw new Error(`refusing to fork ${command.sessionId}: the live session is ${record.id}`)
  }

  const users = record.agent.sessionManager
    .getBranch()
    .filter((entry) => entry.type === 'message' && entry.message.role === 'user')

  if (command.dropTurns > users.length) {
    /* 超出可丢的轮数不夹到边界：静默夹会让「丢 5 轮」变成「丢 3 轮」而没人知道。 */
    throw new Error(
      `cannot drop ${String(command.dropTurns)} turns: only ${String(users.length)} exist`,
    )
  }

  const dropped = users[users.length - command.dropTurns]

  if (command.dropTurns > 0 && dropped === undefined) {
    throw new Error(`no turn to branch at for ${String(command.dropTurns)} dropped turns`)
  }

  const forked =
    command.dropTurns === 0
      ? await record.agent.fork()
      : !(await record.agent.branch(String(dropped?.id))).cancelled

  if (!forked) {
    /*
     * `fork()` 在不能持久化时返回 **false**（不是抛），`branch()` 被扩展取消时回
     * `cancelled`：两个都不能当成成功 —— 报一件没发生的事比报失败坏得多。
     */
    throw new Error('the agent did not fork the session')
  }

  const newId = record.agent.sessionId

  if (newId === record.id) {
    throw new Error('the agent forked but kept the session id')
  }

  return rebind(record, newId)
}

/*
 * 会话清单：agent 自己那份文件目录里有什么。
 *
 * 只报三格。上游的 `SessionInfo` 还带 `allMessagesText`（整条会话的全文），原样转发会
 * 顶穿单行上限（MAX_FRAME_BYTES），Rust 那边直接判连接死掉 —— 清单宁可少几格，
 * 也不能把连接弄断。
 *
 * 范围是这条连接的工作区（一个连接一条会话、锚在一个工作区）。
 */
async function listSessions(): Promise<unknown> {
  const cwd = currentSession()?.agent.sessionManager.getCwd() ?? process.cwd()
  const listed = await SessionManager.list(cwd)

  return {
    sessions: listed.map((entry) => ({
      sessionId: entry.id,
      title: entry.title ?? null,
      /* 上游给的是 Date；线上要的是时刻字符串（ISO）。 */
      updatedAt: entry.modified instanceof Date ? entry.modified.toISOString() : null,
    })),
  }
}

/*
 * 删一条会话：文件与它的产物目录一起删。
 *
 * **必须先经过那个正持有它的 SessionManager**：它拿着写句柄，绕过它删文件会让句柄指着
 * 已经不存在的路径，下一次说话把文件又写回来（omp 自己的会话选择器就是这么处理的，
 * `modes/controllers/selector-controller.ts` 先 `newSession()` 再删）。所以：载进来的走
 * 它自己的 manager，没载进来的才新开一个存储去删。
 *
 * 删不掉（找不到）如实回失败：运行时会把这笔删除当成还欠着，稍后重试。
 */
async function deleteSession(sessionId: string): Promise<unknown> {
  const held = sessions.get(sessionId)
  const manager = held?.agent.sessionManager
  const found = await findSessionFile(sessionId, manager)

  if (found === undefined) {
    throw new Error(`no session file holds ${sessionId}`)
  }

  if (manager !== undefined) {
    await manager.dropSession(found)
  } else {
    await new FileSessionStorage().deleteSessionWithArtifacts(found)
  }

  /* 留着记录会让它在下一次说话时把文件复活：删完就从表里拿掉。 */
  if (held !== undefined) {
    held.unsubscribe?.()
    sessions.delete(sessionId)

    if (active === sessionId) {
      active = null
    }
  }

  return {}
}

/*
 * 导出一份自包含的 HTML。
 *
 * 当前会话走会话自己的导出（带 systemPrompt 与工具段，最全）；其余按文件独立导出，
 * 不必把它装载起来。
 */
async function exportSession(sessionId: string, destination: string): Promise<unknown> {
  const held = sessions.get(sessionId)

  if (held !== undefined && active === sessionId) {
    await held.agent.exportToHtml(destination)

    return {}
  }

  const found = await findSessionFile(sessionId, undefined)

  if (found === undefined) {
    throw new Error(`no session file holds ${sessionId}`)
  }

  const written = await exportFromFile(found, { outputPath: destination })

  if (written === undefined) {
    throw new Error(`the agent could not export ${sessionId}`)
  }

  return {}
}

/*
 * 会话换了号之后重新记账。
 *
 * `fork()` 与 `branch()` 都会把这条连接搬到新会话上（新号、新文件），而我们的表是按号
 * 记的。不重记的话：旧号查得到一条 `agent` 已经在新会话上的记录，之后任何一次说话都会
 * 打到新会话上，而调用方以为自己说的是旧那一条。
 *
 * 新号配一份新的投影器与镜像：分叉出来的是另一条会话，把两条会话的帧缝在同一个镜像里
 * 会让「这条会话到此为止有哪些帧」变成假的。历史由调用方重新拉一次（与开一条会话同路）。
 */
function rebind(record: Session, newId: string): unknown {
  sessions.delete(record.id)

  const rebound: Session = {
    ...record,
    id: newId,
    projector: new TranscriptProjector(),
    mirror: new TranscriptMirror(newId),
  }

  sessions.set(newId, rebound)
  active = newId

  return { sessionId: newId, controls: readSelectors(rebound) }
}

// 新建与重装共用这一条：差别只有「管理器从哪来」，其余必须逐字相同。
async function adopt(manager: SessionManager, cwd: string): Promise<Session> {
  const authStorage = await discoverAuthStorage()
  const modelRegistry = new ModelRegistry(authStorage)
  await modelRegistry.refresh()

  // 号由我们签发。sessionId 先占空串：闸门可能在会话对象拿到号之前就被调到。
  let id = ''

  /*
   * 桌在会话对象之前就要建（createAgentSession 期间就可能被闸门调到），而它报的
   * 「在等人答」要落进会话自己的那张表。中间这个空位就是这段先后的交接。
   */
  let record: Session | null = null

  const desk = new DialogDesk(
    (frame) => {
      /*
       * 题组不走这一条：它有自己的 `questions_asked`（产品形状），同一件事两条路
       * 就会一半认得一半认不得。收窄在这里，而不是让下游去筛两遍 —— 筛两遍就是
       * 第二个判别点（Rust 侧那条 `an_ask_dialog_is_not_also_reported_as_a_raw_dialog`
       * 钉的是同一件事的另一半）。
       */
      if (frame['method'] === 'ask') {
        return
      }

      emit({ kind: 'dialog_requested', sessionId: id, request: frame })
    },
    (event) => {
      if (record !== null) {
        onDialogLifecycle(record, event)
      }
    },
  )

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

  const adopted: Session = {
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
    pending: new Map(),
    asked: new Map(),
    allowed: new Set(),
    compacting: null,
    compactions: 0,
  }

  record = adopted

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

  adopted.unsubscribe = session.subscribe((event) => {
    handleEvent(adopted, event)
  })

  /*
   * 会话交回给调用方之后，它那几个「在等人答」的表由取消与收摊负责清：
   * `desk.closeAll()` 结掉挂着的 Promise，屏幕那几条也由观察者跟着结掉。
   */
  sessions.set(id, adopted)
  active = id

  emit({
    kind: 'selectors',
    sessionId: id,
    controls: await readSelectors(adopted),
    goal: readGoal(adopted),
  })

  if (adopted.agent.messages.length > 0) {
    replayHistory(adopted)
  }

  return adopted
}

/*
 * 按顺序喂给投影器（官方宿主回放历史同一条路）：用户消息开一轮，assistant 与工具结果落轮下。
 *
 * 历史里的图片就在消息正文里（见 `imagesOf`）：omp 读会话文件时已经把 blob 引用换回
 * base64（`resolveBlobRefsInEntries` → `resolveImageData`），所以像素到手了，不必另开通道。
 */
function replayHistory(record: Session): void {
  const project = record.projector
  let endedAt: string | null = null

  for (const message of record.agent.messages) {
    if (message.role === 'user') {
      closeReplayedTurn(record, endedAt)

      const images = imagesOf(message.content, iso(message.timestamp))

      if (images.length > 0) {
        pushTranscript(
          record,
          images.flatMap((image) => image.ops),
        )
      }

      pushTranscript(
        record,
        project.userTurn(
          textOf(message.content),
          images.map((image) => image.attachmentId),
          undefined,
          iso(message.timestamp),
        ),
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

/* 正文帧只装文字：图片块另走 `attachmentOp`（回放历史时由 `imagesOf` 挑出来）。 */
function textOf(content: string | { readonly type: string; readonly text?: string }[]): string {
  if (typeof content === 'string') {
    return content
  }

  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

/*
 * 用户消息里的图片。
 *
 * omp 把图片按 blob 存盘、读会话时又换回 base64 内联进消息正文
 * （`resolveBlobRefsInEntries` → `resolveImageData`，session-loader.ts），所以像素此刻
 * 就在手上 —— 不必另开一条「按 fileId 取字节」的通道（那条通道的注释说「webview 取不到
 * daemon 的 media 端点」，那是 kap 时代的形状，omp 没有那个端点）。
 *
 * 号必须**跨消息唯一**：每条消息都从 `image-0` 起号的话，两条各带一张图的用户消息会撞在
 * 同一个号上，后一张把前一张覆盖掉，两轮显示同一张图。所以号里带上这条消息的时刻。
 */
function imagesOf(
  content:
    | string
    | readonly { readonly type: string; readonly data?: string; readonly mimeType?: string }[],
  stamp: string,
): { readonly attachmentId: string; readonly ops: TranscriptOperation[] }[] {
  if (typeof content === 'string') {
    return []
  }

  const out: { attachmentId: string; ops: TranscriptOperation[] }[] = []

  for (const [index, block] of content.entries()) {
    if (block.type !== 'image' || typeof block.data !== 'string' || block.data === '') {
      continue
    }

    const mediaType = block.mimeType ?? 'image/png'
    const attachmentId = `${stamp}#${String(index)}`

    out.push({
      attachmentId,
      ops: attachmentOp({
        attachmentId,
        mediaType,
        /* 上游给的是裸 base64；`url` 源要的是 data URL。 */
        dataUrl: block.data.startsWith('data:')
          ? block.data
          : `data:${mediaType};base64,${block.data}`,
      }),
    })
  }

  return out
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

    /*
     * 上下文压缩。
     *
     * 这件事不绑 turn（agent 压的是上下文，不是某一轮），所以它走标记而不是轮里的帧。
     * 开门与关门共用同一个号 —— 上游的关门事件不带号，换号就会在屏幕上多出一行，
     * 而人看到的是「上下文被压了两次」这种不存在的历史。
     */
    case 'auto_compaction_start':
      record.compactions += 1
      record.compacting = { markerId: `compaction-${String(record.compactions)}` }
      ops = markerOp({
        markerId: record.compacting.markerId,
        marker: 'compaction',
        payload: { state: 'running' },
      })
      break

    case 'auto_compaction_end': {
      /*
       * 号只作落点：上游在关门事件里没带号，取此刻正在压的那一个；真没有就现起一个
       * （比如中途接上一条已经在压的会话），总比丢掉这一条强。
       */
      const markerId = record.compacting?.markerId ?? `compaction-${String(++record.compactions)}`
      record.compacting = null
      ops = markerOp({
        markerId,
        marker: 'compaction',
        payload: compactionEnded(event),
      })
      break
    }
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

/*
 * 压缩那一行的载荷。
 *
 * 只报 agent 真的给了、而屏幕真的会读的那两格 —— 宁可少一句，也不能是编的：
 * - `state`：上游的 `aborted` 说这次没成，`skipped` 说它压根没动手，`errorMessage`
 *   在也一样，三者都不能说成「完成」。
 * - `tokensBefore`：`CompactionResult` **只有**这一格
 *   （pi-agent-core 的 dist/types/compaction/compaction.d.ts:21-31），没有 `tokensAfter`。
 *   所以后一个缺着 —— 渲染器按缺席退成一句不带数字的话。
 * - `trigger`（手动/自动）：上游的事件里没有这一格，不猜。
 */
function compactionStateOf(event: {
  readonly aborted: boolean
  readonly skipped?: boolean | undefined
  readonly errorMessage?: string | undefined
}): 'cancelled' | 'completed' {
  return event.aborted || event.skipped === true || event.errorMessage !== undefined
    ? 'cancelled'
    : 'completed'
}

function compactionEnded(event: {
  readonly aborted: boolean
  readonly skipped?: boolean | undefined
  readonly errorMessage?: string | undefined
  readonly result?: { readonly tokensBefore?: number | undefined } | undefined
}): Record<string, unknown> {
  const tokensBefore = event.result?.tokensBefore

  return {
    state: compactionStateOf(event),
    ...(typeof tokensBefore === 'number' && Number.isFinite(tokensBefore) ? { tokensBefore } : {}),
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

/*
 * 一次对话框开门/关门 → 屏幕上的那一件「在等人答」。
 *
 * 这是屏幕看得见审批的唯一来源：投影层的 phaseOf 靠 interactions 里有没有 pending
 * 决出 awaiting_permission，而输入框那一带靠那个相位才挂出三颗按钮。少这一条，
 * 授权问答整条回路都在，却没有人被问到。
 *
 * 授权与提问走同一个号空间（都是上游 extension_ui_request 的 id），但那是两件事：
 * 授权翻成 approval，题组翻成 question 并把题装进 request 里 —— 投影层按同一格读它们。
 */
function onDialogLifecycle(record: Session, event: DialogLifecycle): void {
  if (event.kind === 'settled') {
    settleInteraction(record, event.id, event.payload)

    return
  }

  if (event.kind === 'timeout' || event.kind === 'aborted') {
    // 没人答：上游已经把这一次对话框收成 cancelled，屏幕那一条也该结掉。
    closeInteraction(record, event.id, { state: 'cancelled', outcomeReason: event.kind })

    return
  }

  const request = event.request
  const method = typeof request.method === 'string' ? request.method : ''

  if (method === 'ask') {
    openQuestion(record, event.id, request)

    return
  }

  const toolName = approvalToolOf(request)

  if (toolName === null) {
    /*
     * 认不出的对话框（confirm / input / editor / notify）：不是审批也不是题组，
     * 没有「在等人答」这一格可画。上游要的答复照旧由 answer_dialog 那条路送回去。
     */
    return
  }

  const detail = approvalDetailOf(request)

  record.pending.set(event.id, { kind: 'approval', toolName, request })
  pushTranscript(
    record,
    interactionOp({
      interactionId: event.id,
      kind: 'approval',
      state: 'pending',
      toolCallId: toolName,
      /*
       * `title` 是「要不要允许 Bash」答不了的那一半：上游已经算好了将跑什么
       * （tools/approval.ts 把 `Command: …` / 路径 / 新旧正文拼在标题里），
       * 原样带过去给屏幕当主语，不重排也不翻译。
       */
      request: { method, toolName, ...(detail === null ? {} : { detail }) },
    }),
  )
}

/*
 * 一组题在等人答。
 *
 * 题组原样挂进 interaction.request：投影层从那里读 `questions`（transcript-projector
 * 的 interactionOf 正是这样读的），所以屏幕那一格与我们这里看到的是同一份题。
 */
function openQuestion(record: Session, requestId: string, request: UpstreamDialogRequest): void {
  const questions = askQuestionsOf(request.questions)

  if (questions.length === 0) {
    /*
     * 一道都认不出：画不出来，但**不能就这么算了** —— askDialog 的 Promise 还挂着，
     * 人没有可答的东西，模型会永远等下去。如实收成取消（上游把空结果读成「用户取消」，
     * tools/ask.ts:946-949），那一轮因此停在一个说得清的地方，而不是挂死。
     */
    log('an ask dialog arrived with no readable questions; cancelling it')

    record.desk.settle(requestId, { cancelled: true })

    return
  }

  record.asked.set(requestId, questions)
  record.pending.set(requestId, { kind: 'question', toolName: 'ask', request })

  // 原样交给 Rust 去挂提问桌：它按这份题组收答复，答复再经 answer_dialog 回来。
  emit({
    kind: 'questions_asked',
    sessionId: record.id,
    requestId,
    questions,
  })

  pushTranscript(
    record,
    interactionOp({
      interactionId: requestId,
      kind: 'question',
      state: 'pending',
      toolCallId: 'ask',
      request: { questions },
    }),
  )
}

/*
 * 一次答复到了：先把它送回上游，再把屏幕那一条结掉。
 *
 * 次序是有意的 —— 结账先于答复会让屏幕显示「问过了」而 agent 还在等；上游收下之后
 * 才动手，人看到的永远是已经生效的那一件。
 */
function settleInteraction(
  record: Session,
  requestId: string,
  payload: Record<string, unknown>,
): void {
  const held = record.pending.get(requestId)

  if (held === undefined) {
    return
  }

  if (held.kind === 'approval') {
    resolveApproval(record, requestId, held, payload)

    return
  }

  record.pending.delete(requestId)
  const questions = record.asked.get(requestId)
  record.asked.delete(requestId)

  /*
   * 这条答复此刻已经是上游要的那份（dispatch 的 answer_dialog 折过了）：
   * `value` 在就是答了，`cancelled` 在就是撤下了。这里只做归类，不再翻译一次。
   */
  const answer = responseOf(payload)
  const answered = answer.cancelled !== true && answer.value !== undefined

  pushTranscript(
    record,
    interactionOp({
      interactionId: requestId,
      kind: 'question',
      state: answered ? 'answered' : 'dismissed',
      toolCallId: 'ask',
      request: { questions: questions ?? [] },
      ...(answered ? { response: answer.value } : {}),
    }),
  )
}

/*
 * 一次授权答复 → 结论 + （scope=session 时）会话级放行。
 *
 * 「本次会话都批准」不是「再点一次批准」：上游的 select 只有两颗按钮，一次只放行这一次。
 * 真正让这一条会话往后都放行的是 `tools.approval.<tool>: allow` 那条设置 —— 上游
 * resolveApproval 先查用户策略（tools/approval.ts:283-291），所以写进去才算数。
 * 写入走 agent 自己的持久层（Settings.set + flush），由它自己热重载。
 */
function resolveApproval(
  record: Session,
  requestId: string,
  held: PendingInteraction,
  payload: Record<string, unknown>,
): void {
  record.pending.delete(requestId)

  const answer = responseOf(payload)
  const approved = answer.value === APPROVAL_OPTIONS[0]
  const cancelled = answer.cancelled === true

  if (approved && held.toolName !== '') {
    grantSessionWide(record, held.toolName, answer.scope === 'session')
  }

  pushTranscript(
    record,
    interactionOp({
      interactionId: requestId,
      kind: 'approval',
      state: cancelled ? 'cancelled' : approved ? 'approved' : 'rejected',
      toolCallId: held.toolName,
      request: { method: 'select', toolName: held.toolName },
      response: { decision: approved ? 'approved' : 'rejected' },
    }),
  )
}

/*
 * 「本次会话都批准」的落点：把这一件工具写进 agent 自己的 `tools.approval` 表。
 *
 * 上游的 select 只有两颗按钮，一次只放行这一次；真正让这一条会话往后都放行的是
 * `tools.approval.<tool>: allow` 那条用户策略 —— resolveApproval 先查它
 * （tools/approval.ts:283-291），所以写进去才算数，而不是把审批再答一遍。
 *
 * 写入走 agent 自己的持久层（Settings.set + flush），由它自己热重载。写一次就够，
 * 重复写只是同一格的第二次赋值 —— 所以记着写过的。
 */
function grantSessionWide(record: Session, toolName: string, sessionWide: boolean): void {
  if (!sessionWide || toolName === '' || record.allowed.has(toolName)) {
    return
  }

  record.allowed.add(toolName)

  const current = record.settings.get('tools.approval')
  const policies =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {}

  record.settings.set('tools.approval', { ...policies, [toolName]: 'allow' })

  void record.settings.flush().catch((error: unknown) => {
    log('could not persist a session-wide approval', String(error))
  })
}

/** 超时与中止：对话框那边已经作罢，屏幕这一条跟着结掉。 */
function closeInteraction(
  record: Session,
  requestId: string,
  reason: { readonly state: 'cancelled'; readonly outcomeReason: string },
): void {
  const held = record.pending.get(requestId)

  if (held === undefined) {
    return
  }

  record.pending.delete(requestId)
  const questions = record.asked.get(requestId)
  record.asked.delete(requestId)

  pushTranscript(
    record,
    interactionOp({
      interactionId: requestId,
      kind: held.kind,
      state: reason.state,
      toolCallId: held.toolName,
      request: held.kind === 'question' ? { questions: questions ?? [] } : { method: 'select' },
    }),
  )
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
// 批准是**真的问人**：走与工具授权同一条路（同一张桌、同一颗带子、同一道
// answer_permission），所以计划不再自动放行。标题里带上计划文件的路，人据此去读全文 ——
// 计划正文还没有内联的面，不假装已经有了。
async function proposePlan(record: Session, title: string): Promise<PlanReview> {
  const review = await record.agent.preparePlanForReview(title)
  const plan = review.details as PlanApproval | undefined

  if (plan === undefined) {
    return review
  }

  if (!(await askPlanApproval(record, plan))) {
    /*
     * 人没批准：这一次提交作罢，但**留在计划模式里** —— 出模式等于告诉模型可以动手了。
     * 处理器照旧装着，下一版计划还能再提一次。
     */
    return {
      content: [{ type: 'text', text: `计划未获批准：${plan.planFilePath}。修正后重新提交。` }],
      details: plan,
    }
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

/**
 * 把一次计划提交问成人面前的那一次批准；答复由授权那条回路送回来。
 *
 * 故意走闸门那张选项表：`select` 的判据是选项集（Rust 的 approval_of 与这里的
 * approvalToolOf 都这么认），所以人点下去之后送回来的答复与一次工具授权逐字同形 ——
 * 屏幕上是同一颗带子，不需要第二套控件。
 */
async function askPlanApproval(record: Session, plan: PlanApproval): Promise<boolean> {
  const response = (await record.desk.ask({
    method: 'select',
    title: `计划待批准：${plan.title}\n${plan.planFilePath}`,
    options: [...APPROVAL_OPTIONS],
  })) as { value?: unknown }

  return response.value === APPROVAL_OPTIONS[0]
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

// 目录与那一格此刻的值都是 agent 自报的（见 settings.ts），我们没有第二份。
async function settingsCatalog(tab: string | null): Promise<unknown> {
  const settings = await settingsFor()

  return {
    // 键与名成对：键是 agent 的栏目词汇（筛选认它），名是给人看的那一列。
    tabs: SETTING_TABS.map((key) => ({ key, label: tabLabelOf(key) })),
    settings: readCatalog(settings, tab),
    ...configFileOf(),
  }
}

/*
 * agent 此刻在用的那份配置文件。
 *
 * 路径取自它自己的 getAgentDir()（受控时读 PI_CODING_AGENT_DIR）。文件名只能写字面量：
 * `MAIN_CONFIG_FILENAMES` 在 `@oh-my-pi/pi-utils/dirs` 里，而那个包不是我们的依赖
 * （bunfig.toml 的 hoist=false 下未声明的包 import 不到），SDK 也没有转出它。
 * 正本：pi-utils 的 src/dirs.ts:27 `MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"]`。
 *
 * 存在的意义是给人一条出路：几百项设置不必都画成控件，直接改它自己的文件更省事。
 * 路径不由界面拼 —— 那是第二个事实，换个 home 就分叉。
 */
const CONFIG_FILENAMES: readonly string[] = ['config.yml', 'config.yaml']

function configFileOf(): { readonly configFile: string; readonly configFileExists: boolean } {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(getAgentDir(), name)

    if (fs.existsSync(candidate)) {
      return { configFile: candidate, configFileExists: true }
    }
  }

  // 还没写过：报它认的那个写法，界面据此也能把人带过去。
  return {
    configFile: path.join(getAgentDir(), CONFIG_FILENAMES[0] ?? 'config.yml'),
    configFileExists: false,
  }
}

/*
 * 改一格设置：走它自己的持久层，它自己热重载。
 *
 * 写的是它那一层（Settings.set 落盘 + flush），不是我们手上的副本 —— 我们没有副本。
 * 认不出的路径与类型由它自己拒绝，这里不预筛：预筛就是第二份路径表，两边必然分叉。
 */
async function writeSetting(path: string, value: unknown): Promise<unknown> {
  const settings = await settingsFor()

  settings.set(path as never, value as never)
  await settings.flush()

  return { settings: readCatalog(settings, null) }
}

async function writeBrowserSettings(command: {
  readonly enabled?: boolean
  readonly headless?: boolean
  readonly cdpUrl?: string
}): Promise<unknown> {
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
 * 产品只有三颗按钮，上游 select 要一个标签：翻一次再交回去。
 *
 * `scope` 与 `cancelled` 是我们自己加的两格（上游只有 value）：产品那三颗里
 * 「本次会话都批准」与「批准」在上游是同一颗 —— 会话级放行靠 scope 去写
 * `tools.approval.<tool>: allow`，而不是把这次审批再答一遍；而「拒绝」与「取消」
 * 在上游都读成 undefined，屏幕上却必须分得清，所以按产品那三颗如实分成两格。
 */
function answerPermission(
  record: Session,
  command: Extract<BridgeCommand, { type: 'answer_permission' }>,
): unknown {
  const answer = {
    decision: command.decision,
    ...(command.scope === undefined ? {} : { scope: command.scope }),
  }
  const label = labelFor(answer)

  return settleDialog(record, command.requestId, {
    ...(label === undefined ? {} : { value: label }),
    ...(answer.scope === undefined ? {} : { scope: answer.scope }),
    ...(answer.decision === 'cancelled' ? { cancelled: true } : {}),
  })
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
      /*
       * 取消一轮，屏幕上等着人答的那些一起收掉。
       *
       * 上游授权闸门问的那一次 select 不带 signal（wrapper.ts:333），它不会因为这一轮
       * 被取消而自己作罢；谁都不结它，那次工具调用就永远停在 await 上，屏幕上的带子
       * 也永远停在「等你批」。所以这里主动把它们收成取消。
       */
      record.desk.closeAll()
      pushTranscript(record, record.projector.turnEnd('cancelled'))
      emit({ kind: 'turn_end', sessionId: record.id, outcome: 'cancelled' })
      return {}
    }

    case 'steer':
      await required().agent.steer(command.text)
      return {}

    case 'answer_permission':
      return answerPermission(required(), command)

    case 'answer_dialog': {
      const record = required()
      const questions = record.asked.get(command.requestId)

      /*
       * 两组对话框共用这一条命令，而它们期望的答复形状不同：
       * - 题组（ask）：上一条命令收下的产品答复，折回上游那份 results，挂在 `value` 上
       *   （askDialog 就是读那一格的，approval.ts 的 askDialog 分支）；
       * - 其余（confirm / input / editor）：一直就是原样转发。
       * 判据是「这个号是不是一组还在等的题」，不是载荷本身长什么样 —— 载荷长什么样
       * 是调用方知道的，这里只按登记表分派。
       *
       * 折不出结果就是「没答」：`value` 缺席时上游把这次对话框读成取消
       * （tools/ask.ts 的 `if (!richResult)`），那正是撤下整组该有的结局。
       */
      return questions === undefined
        ? settleDialog(record, command.requestId, command.response)
        : settleDialog(record, command.requestId, {
            value: answerPayloadOf(questions, command.response),
          })
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

    case 'fork_session':
      return await forkSession(required(), command)

    case 'sessions':
      return await listSessions()

    case 'delete_session':
      return await deleteSession(command.sessionId)

    case 'export_session':
      return await exportSession(command.sessionId, command.destination)

    case 'browser_settings':
      return { browser: browserSettingsOf(await settingsFor()) }

    case 'settings_catalog':
      return await settingsCatalog(command.tab ?? null)

    case 'set_setting':
      return await writeSetting(command.path, command.value)

    case 'set_browser_settings':
      return await writeBrowserSettings(command)

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
        // 收摊之前先把还挂着的问话结掉：留着它们的 Promise 就永远没有下文了。
        record.desk.closeAll()
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
