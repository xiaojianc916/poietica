/*
 * 桥：omp SDK 的一个进程内调用面。
 *
 * 这里没有 stdout，也没有 NDJSON。调用方拿 createBridge(host) 返回的对象直接说话，
 * 事件经 subscribe 回调出去；stdio 适配器在 main.ts，它把这一面接回线上。
 *
 * 只做三件事：调用方命令 → SDK 调用、SDK event → transcript ops、两者交给监听器。
 * 落账/超时/取消重启归 Rust，这里不做第二套。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AgentSession, AgentSessionEvent } from '@oh-my-pi/pi-coding-agent'
import {
  type AuthStorage,
  buildSkillPromptMessage,
  createAgentSession,
  discoverAuthStorage,
  discoverSkills,
  FileSessionStorage,
  getAgentDir,
  type MCPManager,
  ModelRegistry,
  SessionManager,
  Settings,
  SKILL_PROMPT_MESSAGE_TYPE,
  VERSION,
} from '@oh-my-pi/pi-coding-agent'
import {
  getModelMatchPreferences,
  resolveAllowedModels,
} from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import { getDefault, getUi } from '@oh-my-pi/pi-coding-agent/config/settings-schema'
import {
  disableProvider,
  enableProvider,
  initializeWithSettings,
} from '@oh-my-pi/pi-coding-agent/discovery'
import { exportFromFile } from '@oh-my-pi/pi-coding-agent/export/html'
import { shareSession as uploadSession } from '@oh-my-pi/pi-coding-agent/export/share'
/* MCP 的**配置层**：只读 .mcp.json 那几只文件，不 spawn 服务器。
   discoverMCPServers 会连（loader.ts 的 discoverAndConnect），入口那一格要的只是
   「配了哪几台」，连没连属于连接层，所以这里用配置层那一个。 */
import { loadAllMCPConfigs } from '@oh-my-pi/pi-coding-agent/mcp/config'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import { buildSecretObfuscator } from '@oh-my-pi/pi-coding-agent/secrets'
/* 构成的唯一产地是 omp 自己的状态行口径：它把技能从系统提示词里减出去，还算出空闲
   与自动压缩缓冲。自己折一份就会与它显示的那个分布对不上，所以调它自己读设置的那一支。 */
import { computeSessionContextBreakdown } from '@oh-my-pi/pi-coding-agent/session/context-usage-runtime'
/* 图片的落盘路径要交给 agent 自己认：SDK 靠这个符号注入隐藏的 image-attachment 伴生消息
 * （agent-session.ts:6291-6311 的 `#createAttachmentSourceNotices`）。 */
import {
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
} from '@oh-my-pi/pi-tui/overlays/session-observer-registry'
import { tagImageAttachmentSource } from '@oh-my-pi/pi-tui/prompt/image-source'
import { ensureThemeSync } from '@oh-my-pi/pi-tui/theme'
import { frameId, stepId, type TranscriptOperation, turnId } from '@poietica/transcript'
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
import {
  applyExpectedSelection,
  buildExpectedState,
  type ExpectedServer,
  type ExpectedSkill,
} from './expected-state.ts'
import { removeProvider, writeProvider, writeProviderOverride } from './models-file.ts'
import { outcomeOf, type TurnOutcome } from './outcome.ts'
import { attachmentOp, interactionOp, markerOp, TranscriptProjector } from './projection.ts'
import type {
  AskedQuestion,
  BridgeCommand,
  BridgeEvent,
  GoalSnapshot,
  QueuedState,
  SelectorControl,
  SettingOption,
  UsageSnapshot,
} from './protocol.ts'
import { MAX_PROMPT_IMAGE_BYTES } from './protocol.ts'
import { ASK_TOOL, answerPayloadOf, askQuestionsOf } from './questions.ts'
import { readCatalog, type SettingChoicesOf } from './settings.ts'
import { modelSelectorSettingOf } from './settings-labels.ts'
import { SubagentLedger } from './subagents.ts'
import { settleThinking } from './thinking.ts'
import { TranscriptMirror } from './transcript-mirror.ts'

// omp 的目标类型住在 pi-tui 里、不由 SDK 导出，从会话读法上取。
type GoalOfSession = NonNullable<ReturnType<AgentSession['getGoalModeState']>>['goal']

/* 显示经过里的一条消息。形状由 SDK 自己的 buildSessionContext 决定，从它那里取。 */
type AgentMessage = ReturnType<SessionManager['buildSessionContext']>['messages'][number]

/*
 * 一张模型就绪的图。pi-ai 的 `ImageContent` 没有从 SDK 根导出（index.ts 只挑了几样），
 * 所以从 prompt 自己的入参上取 —— 它跟着 SDK 的签名走，不会与我们抄的一份分叉。
 */
type PromptImage = NonNullable<NonNullable<Parameters<AgentSession['prompt']>[1]>['images']>[number]

/* 上游展开一份 /skill: 交回的那一份（正文 + details），从它自己的函数上取，不抄第二份。 */
type BuiltSkillPrompt = Awaited<ReturnType<typeof buildSkillPromptMessage>>

/* 最后一条 assistant 消息 → 这一轮上报的 token 用量；没有消息或全零时缺席。 */
function usageOf(
  last: unknown,
): { readonly input: number; readonly output: number; readonly cacheRead: number } | undefined {
  if (typeof last !== 'object' || last === null) {
    return undefined
  }
  const usage = Reflect.get(last, 'usage')
  if (typeof usage !== 'object' || usage === null) {
    return undefined
  }
  const input = Reflect.get(usage, 'input')
  const output = Reflect.get(usage, 'output')
  const cacheRead = Reflect.get(usage, 'cacheRead')
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    typeof cacheRead !== 'number' ||
    (input === 0 && output === 0 && cacheRead === 0)
  ) {
    return undefined
  }
  return { input, output, cacheRead }
}

/*
 * 等一次在飞的 MCP 握手的上限。
 *
 * 这是用户能感知的那一格：等太久，技能与 MCP 两格一起空着；等太短，刚起好的那台会被漏掉
 * 一次（下一趟读会补上）。取一个「本机 stdio 服务器握手够用、联网拉包显然不够」的数。
 */
const MCP_HANDSHAKE_GRACE_MS = 1500

/*
 * 屏幕上**实时**铺多少格显示经过。
 *
 * 屏幕不是 transcript 的第二份副本：它只铺最近这一段，更早的由翻页现取（见 warmScreen）。
 * 铺满整条会话就是把 1 万轮的正文全搬进内存与 IPC —— 那正是「打开一条超大对话要 4.5 秒、
 * 165 MB」的来源。
 */
const SCREEN_WINDOW_ENTRIES = 40

/* 往回翻页时一次现投影多少格显示经过（理由见 warmScreen）。 */
const SCREEN_WARM_ENTRIES = 64

/* 这条连接上只有一个 agent，镜像与读法都用这一个号。 */
const MAIN_AGENT_ID = 'main'

/* 正文增量的那个联合：从事件联合里取出来，免得为它再 import 一次上游的 pi-ai。 */
type AssistantDelta = Extract<
  AgentSessionEvent,
  { type: 'message_update' }
>['assistantMessageEvent']

interface Session {
  readonly id: string
  readonly agent: AgentSession
  readonly projector: TranscriptProjector
  /*
   * 屏幕上每一格的身份：显示经过里那份消息的时刻 → 它此刻的轮号。
   *
   * 与 projector 是**两件事**：那个是同一轮的增量写法，这张表记的是显示经过（权威形状）
   * 上一次铺到屏幕上时是什么样。压缩会把更早的 entry 从显示经过里换掉 —— 增量那条路
   * 看不见这件事（它只知道自己写到第几轮），所以每一轮收尾时对一遍这张表，对不上的当场
   * 重投影（见 syncScreen）。空表即「屏幕上还没有任何一格来自显示经过」。
   */
  readonly screen: Map<string, number>
  /** 显示经过最老那一格的号；往回翻到底时页靠它如实说「没有更早的了」。 */
  floor: string | undefined
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
   * （ADR 0002：答复之后什么都不留）。
   */
  readonly pending: Map<string, PendingInteraction>
  /** ask 工具那组题的号 → 题组；答复翻译要用它把号换回标签。 */
  readonly asked: Map<string, readonly AskedQuestion[]>
  /*
   * 最近一次 ask 调用的**工具调用号**。
   *
   * 屏幕要把答完的题挂回发起它的那一次调用下面，而 omp 的 askDialog 只带题组、不带调用号
   * （tools/ask.ts:800 的 `execute(_toolCallId, …)` 收得到却没往下传）。这个号桥自己看得到
   * —— tool_execution_start 带着它。`ask` 在 omp 里是 exclusive（同时至多一个在飞），
   * 所以「最近一次」没有歧义。
   */
  askCallId: string | null
  /** 本次会话已允许的工具（scope=session 的产物），免得重复写同一格设置。 */
  readonly allowed: Set<string>
  /*
   * 正在压的那一次压缩的号与已发出的那几格。
   *
   * 压缩是「开门 → 关门」两件事，而 omp 的关门事件不带开门的号；号要我们自己记，
   * 否则关上门会在屏幕上多出一行而不是把原来那行改掉。关门即清。
   */
  compacting: { readonly markerId: string } | null
  /** 已发生的压缩次数：只作诊断读数，号由位置给（见 handleEvent 的开门那一臂）。 */
  compactions: number
  /*
   * 子代理那一行行的账。
   *
   * omp 把子代理的生死与进度推在根作用域总线上（见 subagents.ts 的模块头），而
   * transcript 的 task.upsert 由这里唯一地产出。收摊时要退订：总线是会话级的，
   * 留着订阅就是让已 dispose 的会话继续往一个死镜像里写。
   */
  readonly subagents: SubagentLedger
  unsubscribeSubagents: (() => void) | null
  /*
   * 已经交给 agent、还没在上下文里露面的插话，按投递顺序排着。
   *
   * 上游的 `message_start` 只是「有一条消息进了上下文」，不带它从哪个队列来的；而
   * 开场那句 prompt 也会走同一条事件。所以投递时就记下正文，事件到了按正文认领：
   * 认领的那一条说明模型真的看见了 —— 屏幕此刻才把它画进那一轮，队列 chip 也才该消失。
   * 认不出来的一律不动（宁可少画一条，也不把开场白错画成插话）。
   */
  readonly injections: PendingInterjection[]
}

/** 一条投出去的插话：正文是认领判据，层决定它在不在 agent 的队列里。 */
interface PendingInterjection {
  readonly text: string
  readonly deliverAs: 'steer' | 'followUp'
}

interface PendingInteraction {
  readonly kind: 'approval' | 'question'
  /** 授权那一类用它做设置键（会话级放行）与屏幕上的说法；题组恒为 'ask'。 */
  readonly toolName: string
  readonly request: UpstreamDialogRequest
  /**
   * 发起这一次对话框的工具调用号（只有题组有）。
   *
   * 授权那一路拿不到：审批可以在多个工具之间并发，而对话框里没有调用号，
   * 「最近一次」会对错人。题组没有这个问题 —— ask 是 exclusive 的。
   */
  readonly toolCallId?: string
}

/*
 * 宿主上下文：受控 home 与工作区。SDK 自己读写 node:fs，这里不代劳，只告诉它在哪。
 */
export interface BridgeHost {
  /** 受控 home 的绝对路径，对应 PI_CODING_AGENT_DIR。 */
  readonly agentDir: string
  /** 工作区根目录；会话没带 cwd 时用它兜底。 */
  readonly cwd: string
  /** 要覆盖的环境变量，只放白名单键。 */
  readonly env?: Readonly<Record<string, string>>
}

export type BridgeListener = (event: BridgeEvent) => void

/*
 * 调用面刻意只有三个成员：`dispatch` 收 BridgeCommand 那个判别式联合，命令清单因此只有一份；
 * 再铺一层同名转发方法就是第二个清单（AGENTS.md §5「单一分发点」）。`agentVersion` 是 SDK 自报的
 * 版本，线上那条 ready 帧要用它；让适配器自己 import SDK 去读，等于让它认识 SDK。
 */
export interface Bridge {
  readonly dispatch: (command: BridgeCommand) => Promise<unknown>
  readonly subscribe: (listener: BridgeListener) => () => void
  readonly agentVersion: string
}

export function createBridge(host: BridgeHost): Bridge {
  /*
   * 环境必须先落地：SDK 的 agent 目录是**模块加载时**解析的（pi-utils/src/dirs.ts:446-449），
   * 那时 PI_CODING_AGENT_DIR 已经定下。这里不是去改它，而是跟调用方说的对一次账 ——
   * 对不上就报错，绝不静默写到用户自己的 ~/.omp 去（AGENTS.md §5「错误一套规则」）。
   *
   * 比较走 path.resolve 两侧：SDK 那边也是 resolve（dirs.ts:334），不这么对齐会把
   * 尾斜杠、`.` 段这类写法差读成"home 不符"，那是把一个真检查变成起不来。
   */
  for (const [key, value] of Object.entries(host.env ?? {})) {
    process.env[key] = value
  }

  /*
   * pi-tui 的主题是模块单例（theme.ts 的 `export var theme`），只在它自己的引导里赋值：
   * omp 的 CLI 走 main.ts:1661，我们不走 main.ts。而 ask 工具有一句**无条件**读它的
   * 保留标签（tools/ask.ts:120，execute 在 839 行读），单例空着就是必炸：
   * `undefined is not an object (evaluating 'theme.status')`，提问全线不可用。
   * 同步那一支够用：内置主题是内联 JSON，不碰盘、不看 tty；无终端宿主本来也不上色。
   */
  ensureThemeSync()

  const resolved = getAgentDir()

  if (path.resolve(resolved) !== path.resolve(host.agentDir)) {
    throw new Error(
      `agent home mismatch: the SDK resolved ${resolved}, the host asked for ${host.agentDir}`,
    )
  }

  /*
   * 关掉 omp 自发的会话标题生成 —— 不花用户没点的钱。上游在首条消息与 todo 首次初始化后
   * 自己发一次标题请求（agent-session.ts 的 maybeStartTitleGeneration）：选模型
   * tiny → commit → smol，都没配就退回**当前会话模型**（title-generator.ts 的
   * getTitleModels），而我们只写 modelRoles.default —— 这一次调用落到用户自己的模型与
   * 密钥上，输入是最近六轮真实对话。产品用不上：标题正本在本地 threads 表，omp 生成的
   * 标题在本仓没有上屏出口。赋值在这里就够：上游读的 pi-utils $env 与 process.env 是
   * 同一个活对象（env.ts 只在加载期补尚未设置的键），任何一次读之前落地都算数；
   * 官方 rpc/acp 模式也置它。
   */
  process.env['PI_NO_TITLE'] = '1'

  /*
   * 关掉终端通知 —— 它往 stdout 直接写 BEL / OSC 转义序列，而 stdout 是我们的
   * NDJSON 协议通道：那串字节没有换行，会和下一条 JSON 行粘在一起，对端解不开。
   * 触发点是 ask 工具（tools/ask.ts 的 `#sendAskNotification`，`ask.notify` 默认 on）
   * 在等人答题时无条件发一次 —— 于是**每次提问都会毒掉一条协议行**。
   *
   * 这正是 omp 官方 RPC 模式的做法，理由逐字相同（modes/rpc/rpc-mode.ts:817-821：
   * 「they write \x07 (BEL) or OSC sequences directly to process.stdout with no
   * newline, which the reader merges with the next JSON line and breaks JSON.parse」）。
   * 赋值在这里就够：上游读的 pi-utils $env 与 process.env 是同一个活对象。
   */
  process.env['PI_NOTIFICATIONS'] = 'off'

  /*
   * 关掉交互式 PTY —— 我们这套 UIContext 只实现问得出人的那几个，其余是空壳，
   * 终端呈现面那一格（approval.ts:371 的 custom）以 undefined 兑现。而 SDK 的闸门
   * 只看 hasUI 与 ui 在不在场（tools/bash-pty-selection.ts:13），看不出宿主画不了
   * overlay：pty:true 因此会选中 tools/bash.ts:1415 的交互分支，落到 ui.custom 上
   * 立刻拿到 undefined，bash.ts:1440 读 result.cancelled 当场 TypeError。
   *
   * 置 1 走 SDK 自己的开关（同文件 :12），pty:true 于是落到 tools/bash.ts:1410-1412
   * 已经写好的降级路径：命令照常跑，附一条「pty requested but unavailable」的 notice。
   * 官方 rpc-ui 模式也置它（上游 src/main.ts:1787）。「宿主没有终端」是环境事实而非
   * 用户配置，所以与上面两行同类：运行时赋值就够，不进档案的 env 格（ADR 0019）。
   */
  process.env['PI_NO_PTY'] = '1'

  // 诊断走 stderr：stdio 适配器那边 stdout 是协议通道，多一个字会毁掉那一行。
  const log = (...parts: readonly unknown[]): void => {
    process.stderr.write(`${parts.map(String).join(' ')}\n`)
  }

  /* 一个监听器抛错不能带走桥：注册进来的代码不是会话的真相来源，出错只记一笔。 */
  const listeners = new Set<BridgeListener>()

  const emit = (event: BridgeEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        log('event listener failed', error instanceof Error ? error.message : String(error))
      }
    }
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

  /*
   * 在飞的水合。
   *
   * 开新对话时号由 `SessionManager.create` 当场签发（实测 3.5ms），而
   * `createAgentSession` 要做的全量发现是这一段里最贵的一步。号既然先有了，就可以先把
   * 号与「期望态」那张表交出去，把发现放后台 —— 屏幕上的工具条因此不必等水合。
   *
   * 失败要能被**之后**的命令看见（号已经交出去了，静默会变成「会话凭空消失」），所以
   * 这个承诺一直挂着；同时挂一个 catch，免得没人等它时算成未处理拒绝。
   */
  let hydrating: Promise<unknown> | null = null

  /*
   * 正在水合的那条会话锚在哪个工作区。
   *
   * 号已经交出去、会话对象还没有，`workspaceOf()` 这会儿在 sessions 里找不到它，会退回
   * 宿主启动时的 cwd —— 而新对话可能开在另一个目录上。这一格就是补那个缺口的：
   * 水合期间读期望态（技能、MCP 配置、模型目录）要用它，不然会去错目录里扫技能。
   */
  let hydratingCwd: string | null = null

  /* 号当场交出去，会话对象在后台建。返回的就是新号。 */
  function mintSession(cwd: string): string {
    const manager = SessionManager.create(cwd)
    const id = manager.getSessionId()
    const started = queueInit(() => adopt(manager, cwd))

    void started.catch(() => {})
    hydrating = started
    hydratingCwd = cwd
    active = id

    return id
  }

  /* 需要会话对象的命令先等这一趟；没有在飞的就直接过。失败往上传（fail closed）。 */
  async function settleHydration(): Promise<void> {
    const pending = hydrating

    if (pending === null) {
      return
    }

    try {
      await pending
    } finally {
      if (hydrating === pending) {
        hydrating = null
        hydratingCwd = null
      }
    }
  }

  /*
   * 期望态那一份：进程级事实，**不建会话**。
   *
   * 入口那一屏要的是「用户配成什么样」（模型/权限/档位/技能/MCP 配置），这件事住在配置
   * 与目录里，不住在会话对象里。此前它被 readSelectors 挡住 —— 那条要会话对象，于是
   * 「点开新对话看到工具条」必须等整次水合（createAgentSession 的全量发现）。
   *
   * 三样并行取，谁都不依赖谁：`settingsFor()` 那一份可写设置、模型目录、盘上的技能与
   * MCP 配置。模型身份由官方解析器从目录里算（见 expected-state.ts），不自己拼。
   */
  let registryPromise: Promise<ModelRegistry> | null = null

  /*
   * 模型目录：期望态那一趟读它，`adopt` 建会话也用它 —— 同一个注册表，两条路读到的是
   * 同一份表，不会各补一遍目录。
   *
   * 与 SDK 自己的嵌入方引导同一次序（sdk.ts 的 hydrateCredentialScopedModelCaches +
   * refreshInBackground）：先本地补目录，联网发现放后台。不能 await refresh()：它默认
   * online-if-uncached，缓存过了 24h 就当场等网络 —— 实测 585ms（断网）对 10442ms（联网）。
   */
  function registryFor(): Promise<ModelRegistry> {
    registryPromise ??= (async () => {
      const authStorage = await discoverAuthStorage()
      const registry = new ModelRegistry(authStorage)

      await registry.hydrateCredentialScopedModelCaches()
      registry.refreshInBackground()

      return registry
    })()

    return registryPromise
  }

  /*
   * 设置里点名的那条模型，从**本地目录**解析。
   *
   * 比法是**整串**（`provider/id`，见 catalog.ts 的 aliasOf —— 界面上的名字就是它），
   * 不是「按最后一个斜杠切两半」：id 自己带斜杠（`workbuddy-ai/deepseek-v4.1-flash`），
   * 切错了就找不到那一条，于是白等一次联网兜底。目录里没有就如实回 undefined ——
   * 让 SDK 走它自己那条兜底，而不是这里编一个。
   *
   * 拦两种情形：这条设置根本不在场（全新用户），或者它在场而本地目录里没有这一条
   * （凭据过期、models.yml 被改过）。有凭据才交出去 —— 没凭据的那条起不了轮。
   */
  async function preferredModel(
    registry: ModelRegistry,
  ): Promise<ReturnType<ModelRegistry['find']> | undefined> {
    const settings = await settingsFor()
    const selector = settings.get('modelRoles')?.['default']

    if (typeof selector !== 'string' || selector === '') {
      return undefined
    }

    const model = registry.getAll().find((entry) => aliasOf(entry) === selector)

    return model !== undefined && registry.hasConfiguredAuth(model) ? model : undefined
  }

  /*
   * 入口那一趟的读。三样并行取，谁都不依赖谁。
   *
   * 设置读的是 `settingsFor()`（`Settings.init` 那一份可写实例）：期望态那两格要在
   * 入口就能改，而 `loadReadOnly` 拿到的实例 `#persist = false`（settings.ts:605），
   * set 完 flush 不落盘 —— 用它读会出现「点了没反应」。
   */
  async function readExpectedState(
    cwd: string,
  ): Promise<{ controls: SelectorControl[]; skills: ExpectedSkill[]; servers: ExpectedServer[] }> {
    const settings = await settingsFor()
    const [registry, skills, mcp] = await Promise.all([
      registryFor(),
      discoverSkills(cwd),
      loadAllMCPConfigs(cwd),
    ])

    const state = await buildExpectedState({
      registry,
      settings,
      skills: skills.skills,
      servers: Object.keys(mcp.configs),
      skillSourceOf,
      thinkingOptions: THINKING_OPTIONS,
    })

    return {
      controls: [...state.controls],
      skills: [...state.skills],
      servers: [...state.mcpServers],
    }
  }

  /*
   * 改入口的格子：还没有会话时的那条写法。
   *
   * 只有模型与权限两格是**配置**，改了立刻落盘、omp 自己热重载；计划与目标两格是会话
   * 状态，入口只作展示，改动由第一句随 prompt 生效（appliesOnSubmit）。四条纪律的
   * 「会话前用配置、会话后只碰同步 getter」在这里落地：没有会话就走这一条。
   */
  async function writeExpectedState(configId: string, value: string): Promise<void> {
    const settings = await settingsFor()
    const outcome = await applyExpectedSelection({ settings, configId, value })

    if (outcome === 'session') {
      throw new Error(
        `the ${configId} selector needs a session; it cannot be set before one exists`,
      )
    }
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
      (await SessionManager.list(manager?.getCwd() ?? host.cwd)).find(
        (entry) => entry.id === sessionId,
      )?.path ?? (await SessionManager.listAll()).find((entry) => entry.id === sessionId)?.path
    )
  }

  /*
   * 从某一轮分叉。上游没有「丢 N 轮再复制」这一个动作，得自己拼：`dropTurns === 0` 走
   * `AgentSession#fork()`（整份克隆并重锚）；`dropTurns > 0` 走 `AgentSession#branch(entryId)`
   * （createBranchedSession 截到那条之前再重锚）。branch() 只认 user 消息作锚
   * （agent-session.ts:10069），所以「丢 N 轮」就是锚在倒数第 N 条 user 消息上。
   * **这一步会把这条连接移到新会话上**，回来之后要重新记账（rebind），否则之后用旧号
   * 说话会打到新会话上。
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
    /* 水合期间会话对象还没有，`currentSession()` 会退回宿主的 cwd —— 新对话可能开在
       另一个目录上，清单就会列错工作区。先让它落定。 */
    await settleHydration()

    const cwd = currentSession()?.agent.sessionManager.getCwd() ?? host.cwd
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
   * **必须先经过那个正持有它的 SessionManager**：它拿着写句柄，绕过它删会让句柄指着
   * 不存在的路径，下一次说话把文件又写回来（omp 的选择器同此处理：selector-controller.ts
   * 先 newSession() 再删）。删不掉（找不到）如实回失败：运行时把这笔删除当成还欠着，稍后重试。
   */
  async function deleteSession(sessionId: string): Promise<unknown> {
    /* 会话文件要到水合时才落盘（`SessionManager.create` 只签发号），见 shareSessionFor。 */
    await settleHydration()

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
      held.unsubscribeSubagents?.()
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
    /* 同上：文件还没落盘时按号找不到，导出会凭空说「没有这条会话」。 */
    await settleHydration()

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
   * 把一条会话传到 omp 自己的分享服务。
   *
   * **这是唯一会把对话正文送出本机的动作**，所以脱敏不是可选项：判据与 omp 自己
   * 完全一致 —— `src/commands/share.ts:59-66` 的
   * `settings.get('share.redactSecrets') && settings.get('secrets.enabled')` 两格
   * 都为真才建 obfuscator，两格默认值（true / false）也由它自己的 schema 给。少抄
   * 一个判据就是一个泄漏：这两格设置我们没删，正是留在这里读的。
   *
   * 设置按**会话自己的工作目录**解析（`Settings.loadReadOnly({cwd})`），与 omp 同：
   * 一条会话属于它自己的工程，脱敏策略该由那个工程说了算，而不是此刻这条连接站在哪。
   *
   * `store` 与 `serverUrl` 都交给 omp 的默认，不在这里写死：那两格是它的设置
   * （`share.store` / `share.serverUrl`），我们抄一份就是第二个事实。
   *
   * 会话号可能不是这条连接上活着的那一条（界面上可以分享任何一条），所以走
   * `SessionManager.open` 按文件另开一个管理器 —— 与 `omp share <session>` 同路。
   */
  async function shareSessionFor(sessionId: string): Promise<unknown> {
    /*
     * 先等在飞的水合：新对话的号是当场签发的，而**会话文件要到水合时才落盘**
     * （`SessionManager.create` 只签发号，实测文件此时还不存在），此时按号找文件必然找不到。
     */
    await settleHydration()

    const held = sessions.get(sessionId)
    const manager =
      held?.agent.sessionManager ??
      (await findSessionFile(sessionId, undefined).then((found) =>
        found === undefined ? undefined : SessionManager.open(found),
      ))

    if (manager === undefined) {
      throw new Error(`no session file holds ${sessionId}`)
    }

    const settings = await Settings.loadReadOnly({ cwd: manager.getCwd() })
    const obfuscator =
      settings.get('share.redactSecrets') && settings.get('secrets.enabled')
        ? await buildSecretObfuscator(manager.getCwd(), getAgentDir())
        : undefined

    /* `obfuscator` 缺席即整格不传：ShareSessionOptions 那一格不收显式的 undefined。 */
    const shared = await uploadSession(manager, obfuscator === undefined ? {} : { obfuscator })

    return { url: shared.url, truncated: shared.truncated }
  }

  /*
   * 会话换了号之后重新记账：fork()/branch() 都会把这条连接搬到新会话上，而我们的表按号记，
   * 不重记的话之后任何一次说话都会打到新会话上，而调用方以为说的是旧那一条。
   * 新号配新的投影器与镜像：两条会话的帧缝在同一个镜像里会让「到此为止有哪些帧」变假；
   * 历史由调用方重新拉一次（与开一条会话同路）。
   */
  function rebind(record: Session, newId: string): unknown {
    sessions.delete(record.id)

    const rebound: Session = {
      ...record,
      id: newId,
      projector: new TranscriptProjector(),
      screen: new Map(),
      floor: undefined,
      mirror: new TranscriptMirror(newId),
    }

    sessions.set(newId, rebound)
    active = newId

    return { sessionId: newId, controls: readSelectors(rebound) }
  }

  // 新建与重装共用这一条：差别只有「管理器从哪来」，其余必须逐字相同。
  async function adopt(manager: SessionManager, cwd: string): Promise<Session> {
    /*
     * 用期望态那一个注册表（同一次补目录、同一次后台联网发现）：两条路各有各的注册表
     * 就会补两遍目录，用户改过 models.yml 之后还可能读到两份不同的表。见 registryFor。
     *
     * 凭据页从它自己身上取（构造时就是它的第一格），不再 discoverAuthStorage 一遍 ——
     * 那是一次盘读，两次读到的还是同一份。
     */
    const modelRegistry = await registryFor()
    const authStorage = modelRegistry.authStorage

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

    /*
     * 模型**显式交进去**，省掉 SDK 自己那次解析（`modelRoles.default` → 本地目录 → 联网兜底）。
     *
     * 这一次解析平时只要几百毫秒（真实 home 实测 371 ms），但**解析不出来时**它会退到联网
     * 发现兜底，而那一趟要等几个连不上的端点各自超时：本机实测 10 554 ms。凑巧的是那条路
     * 走完还常常给不出模型（`model: null`）—— 等了十秒，什么都没换到。
     *
     * 解析不出来时这里**不硬塞**别的模型（塞错比慢坏得多）：如实回 undefined，让 SDK 走它
     * 自己那条兜底 —— 那时慢是应该的，因为用户确实需要那一次发现。
     */
    const preferred = await preferredModel(modelRegistry)

    const { session, setToolUIContext, mcpManager, subagentEventBus } = await createAgentSession({
      cwd,
      authStorage,
      modelRegistry,
      settings: await settingsFor(),
      sessionManager: manager,
      // hasUI 必须 true（为什么见下方 initializeExtensions 处的两步说明）。
      hasUI: true,
      ...(preferred === undefined ? {} : { model: preferred }),
    })

    id = session.sessionId ?? crypto.randomUUID()

    const adopted: Session = {
      id,
      agent: session,
      projector: new TranscriptProjector(),
      screen: new Map(),
      floor: undefined,
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
      askCallId: null,
      allowed: new Set(),
      compacting: null,
      compactions: 0,
      subagents: new SubagentLedger({ now: Date.now }),
      unsubscribeSubagents: null,
      injections: [],
    }

    record = adopted

    const uiContext = createUIContext(desk)

    setToolUIContext(uiContext, true)

    /*
     * 两步缺一不可：setToolUIContext 只把 UI 交给工具上下文，而授权闸门读 runner.hasUI()，
     * runner 的 UI 由 initializeExtensions 装进去；只做第一步，非 yolo 下每次 write/exec
     * 都抛 no interactive UI（fail closed）。
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

    adopted.unsubscribe = session.subscribe((event) => {
      handleEvent(adopted, event)
    })

    /*
     * 入队之前就被取消的那一句，只有这一个出口。
     *
     * 上游在两种竞态里响它：abort 或用量预检把这一轮抢掉了（agent-session.ts:6588、
     * 6600），那时这句话**没有落进会话文件**，transcript 里也就永远不会有它。不接
     * 就等于用户那句话凭空消失 —— 屏幕上那条乐观记录还挂着，agent 永远不回应答。
     */
    session.setPromptDropped((prompt) => {
      emit({ kind: 'prompt_dropped', sessionId: adopted.id, text: prompt.text })
    })

    /*
     * 子代理那三个频道接上。
     *
     * 总线是**根作用域**的：这条会话里再生的子代理全在它上面报（sdk.ts:1372 建一次，
     * 传给整棵树）。三个频道里只订两个 —— `task:subagent:event` 是每个子代理的原始
     * AgentSessionEvent 洪流（官方只在 events 级订阅时才要它），我们要的是那一行行的
     * 生死与进度，不是第二份正文。
     *
     * 每一条都推成 transcript 的 task.upsert：后台任务面板与它的秒针早就在等这个
     * （packages/conversation 的 backgroundOf），此前没有任何生产者。
     */
    adopted.unsubscribeSubagents = subagentEventBus
      ? subscribeSubagents(adopted, subagentEventBus)
      : null

    /*
     * 开工前把思考档位收敛到这条模型自己的梯子上（见 thinking.ts）。放在订阅之前：
     * 这一步自己会发一次 thinking_level_changed，订阅了就等于多报一遍选择器，而
     * 下面那一次报的就是收敛后的值。放在读之前：报出去的值必须是 agent 此刻真的
     * 持有的那一档。
     *
     * 全局那一档取上游 schema 的默认（`defaultThinkingLevel`，实测 "high"）：它就是
     * 「一条全新会话本来会拿到的那一档」。产品里这一格的改动只有输入框那一排那颗胶囊
     * （settings-labels.ts 的 CONTROLLED_ELSEWHERE 把设置页那一行收了），所以盘上那份
     * 基本就是 schema 默认。
     */
    settleThinking(adopted, getDefault('defaultThinkingLevel'))

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
      const frame = syncScreen(adopted)

      adopted.floor = frame.floor
      pushTranscript(adopted, frame.ops, true)
    }

    return adopted
  }

  /*
   * 屏幕上每一格的来源：**omp 自己的显示经过**，不是模型上下文。
   *
   * 两者的差别在压缩过的长对话上：模型上下文是「摘要 + 保留的尾部」，照它回放，重开一条
   * 老对话时被压掉的历史直接从屏幕上消失，也翻不回来。显示经过（`transcript: true`）是
   * 按 entry 顺序的那一份，压缩在里面是一条 `compactionSummary` 消息，位置就是它发生的地方。
   *
   * 折叠与否读的是 omp 自己那一格设置（`display.collapseCompacted`，官方默认 true）：折叠时
   * 被最近一次压缩取代的那些 entry 不再回放，但压缩本身留着 —— 屏幕上是一条分界线，不是
   * 一个空洞；不折叠时前面那些轮次也在。两条路都不丢内容。
   */
  function screenTurns(record: Session): readonly ScreenTurn[] {
    const context = record.agent.sessionManager.buildSessionContext({
      transcript: true,
      collapseCompactedHistory: record.settings.get('display.collapseCompacted') !== false,
    })
    const turns = groupTurns(context.messages, resultsOf(context.messages))

    /*
     * 屏幕上最新那一轮此刻还在跑吗：在跑的话它是 running，屏幕上那行从「正在处理」走成
     * 「已处理 + 真实耗时」。判据是**投影器手上还开着轮**（增量那条路正在写这一轮）——
     * 显示经过里最后一格是不是助手消息不算数：刚收轮、还没落盘的那一瞬间两边会对不上。
     */
    const newest = turns.at(-1)

    return newest !== undefined && record.projector.isTurnOpen
      ? [...turns.slice(0, -1), { ...newest, state: 'running', endedAt: null }]
      : turns
  }

  /*
   * **一轮从「人说的话」开始，到下一句人话为止** —— 与增量那条路同一个判据。
   *
   * 一次 omp turn 里模型会跑好几趟（每趟一条 assistant 消息，外加一条 toolResult），
   * 所以「一条消息一格」会把一次对话拆成好几行「已处理 0 秒」；这里按人话归拢，assistant
   * 消息各占一个段，工具结果并回发起它的那一次调用。
   *
   * 时间给成**真实的一对**：开场那一刻（人那句）到这一轮最后一次说话那一刻。两头不能取自
   * 同一条消息 —— 封条按 `endedAt - startedAt` 算「已处理多久」，那样每一行都是「0 秒」。
   */
  function groupTurns(
    messages: readonly AgentMessage[],
    results: ReadonlyMap<string, ScreenResult>,
  ): ScreenTurn[] {
    const turns: ScreenTurn[] = []
    let open: OpenTurn | null = null

    const seal = (): void => {
      if (open === null) {
        return
      }

      const held = open

      open = null

      const turn = turns.length + 1
      const last = held.steps.at(-1) ?? null

      turns.push({
        turn,
        /* 身份 = 轮号 + 开场那一刻：滚上去再回来看，还是同一格。 */
        id: `t${String(turn)}@${messageKey(held.opening, 0)}`,
        opening: held.opening,
        prompt: held.prompt,
        steps: held.steps,
        openedAt: stampOf(held.prompt ?? held.opening),
        endedAt: last === null ? null : stampOf(last),
        state: 'completed',
        results,
      })
    }

    for (const message of messages) {
      if (message.role === 'toolResult' || !isVisible(message)) {
        continue
      }

      const starts = message.role === 'user' || message.role === 'compactionSummary'

      if (starts || open === null) {
        seal()
        open = { opening: message, prompt: message.role === 'user' ? message : null, steps: [] }

        /* 没有开场白的那种（会话从助手那一侧开始）：它自己就是这一轮的第一步。 */
        if (!starts) {
          open.steps.push(message)
        }

        continue
      }

      open.steps.push(message)
    }

    seal()

    return turns
  }

  /*
   * 工具调用的结果：号是 toolCallId。
   *
   * 单独先收一趟：结果消息排在发起调用的那条消息**后面**，建轮时拿不到。
   */
  function resultsOf(messages: readonly AgentMessage[]): Map<string, ScreenResult> {
    const results = new Map<string, ScreenResult>()

    for (const message of messages) {
      if (message.role !== 'toolResult') {
        continue
      }

      const callId = (message as { readonly toolCallId?: unknown }).toolCallId

      if (typeof callId === 'string' && callId !== '') {
        results.set(callId, {
          content: (message as { readonly content?: unknown }).content,
          details: (message as { readonly details?: unknown }).details,
          isError: (message as { readonly isError?: unknown }).isError === true,
        })
      }
    }

    return results
  }

  /*
   * 这一条消息上不上屏。
   *
   * omp 自己给合成的横幅打了 `display: false`（目标模式那一条 `<goal_context>`，
   * `#fo()` 里 `role:"custom", customType:"goal-mode-context", display:!1`）—— 它是给模型看的
   * 上下文，不是用户说过的话。少判这一格，屏幕上就会多出一轮「已处理 0 秒」的空轮。
   */
  function isVisible(message: AgentMessage): boolean {
    return (message as { readonly display?: unknown }).display !== false
  }

  interface OpenTurn {
    readonly opening: AgentMessage
    readonly prompt: AgentMessage | null
    readonly steps: AgentMessage[]
  }

  interface ScreenTurn {
    /** 屏幕上的第几轮（1 起）。 */
    readonly turn: number
    /** 这一轮的身份：开场那条消息 + 轮号（见 messageKey）。 */
    readonly id: string
    /** 开这一轮的那条消息（用户那句，或压缩那条）。 */
    readonly opening: AgentMessage
    /** 用户那句；没有开场白时缺席（会话从助手那一侧开始）。 */
    readonly prompt: AgentMessage | null
    /** 这一轮里模型的每一趟各占一条（正文、思维链、工具调用都在里面）。 */
    readonly steps: readonly AgentMessage[]
    readonly openedAt: string
    readonly endedAt: string | null
    readonly state: 'running' | 'completed'
    /** 这条会话里工具调用的结果：号是 toolCallId。 */
    readonly results: ReadonlyMap<string, ScreenResult>
  }

  interface ScreenResult {
    readonly content: unknown
    readonly details: unknown
    readonly isError: boolean
  }

  /*
   * 一条显示经过的消息在屏幕上的身份。
   *
   * 号必须跨帧稳定：同一个号要让「上一帧这一格」与「这一帧这一格」认成同一件事，才谈得上
   * 只重写着实变了的那几格（见 `syncScreen`）。时刻是 omp 自己给的锚点；缺席时退回它在
   * 显示经过里的位置。
   */
  function messageKey(message: AgentMessage, at: number): string {
    const stamp = message.timestamp

    /* 时刻在场用它（它在显示经过里唯一）；不在场就用位置 —— 两者都跨进程稳定。 */
    return typeof stamp === 'number' && Number.isFinite(stamp)
      ? new Date(stamp).toISOString()
      : `at-${String(at + 1)}`
  }

  /*
   * 往回翻到镜像手上还没有的那一段时，现投影一小段。
   *
   * 从请求的那一格往回取 SCREEN_WARM_ENTRIES 格：一页（PAGE_BUDGET_BYTES）通常装得下
   * 这么多，所以多数翻页只需补一次；补得多了只是多投影几格纯构帧，补得少了多花一次往返。
   * 只补比游标**更早**的那些：游标那一格客户端手上已经有。
   */
  function warmScreen(record: Session, beforeTurn: string, stagedFrom: number | undefined): void {
    const turns = screenTurns(record)
    const from = turns.findIndex((entry) => turnId(entry.turn) === beforeTurn)

    if (from < 0) {
      return
    }

    /* 只补比手上那些**更早**的段：已有的再发一遍就是白花一次整页的字节。 */
    const start = Math.max(0, from - SCREEN_WARM_ENTRIES)
    const staged = turns
      .slice(start, from)
      .filter((entry) => entry.turn < (stagedFrom ?? Number.POSITIVE_INFINITY))

    pushTranscript(
      record,
      staged.flatMap((entry) => screenOps(record, entry)),
      true,
    )
  }

  /*
   * 把显示经过搬到屏幕上：交回来的一批 ops 只包含**与上一帧不同**的那些格。
   *
   * 打开会话时是整份（屏幕上还什么都没有）；此后每轮收尾对一次，通常只差最后那一格。
   * 压缩发生时更早的那些格会整段重排 —— 那正是这一步要如实反映的事：屏幕上那一条分界线
   * 出现时，它前面的轮次被换成了压缩后的版本，而不是凭空消失。
   */
  function syncScreen(record: Session): ScreenFrame {
    const turns = screenTurns(record)
    const tail = Math.max(0, turns.length - SCREEN_WINDOW_ENTRIES)

    /*
     * 增量那条路（流式帧）的号与这里必须对齐：显示经过里工具结果是**独立一格**，而流式
     * 那条路把它并进助手那一轮。让累加器坐在这一轮上（见 TranscriptProjector.seat），
     * 两者才认得同一格；不然接着说话就会用旧号盖掉屏幕上已有的轮。
     */
    const newest = turns.at(-1)

    if (newest !== undefined && !record.projector.isTurnOpen) {
      record.projector.seat(newest.turn)
    }

    const changed = turns.filter((entry, at) => isRestaged(record, entry, at, tail))
    const ops = changed.flatMap((entry): TranscriptOperation[] => [
      { op: 'items.remove', ids: [turnId(entry.turn)] },
      ...screenOps(record, entry),
    ])

    restage(record, turns, changed, tail, ops)

    /* floor 是**轮号**不是格子 id：页与游标说的都是轮号（见 transcript-store 的 earlier）。 */
    const first = turns[0]

    return { ops, floor: first === undefined ? undefined : turnId(first.turn) }
  }

  /** 这一格要不要重铺：变了，并且落在屏幕上（窗口之内或用户翻页翻到过的那几格）。 */
  function isRestaged(record: Session, entry: ScreenTurn, at: number, tail: number): boolean {
    return (
      record.screen.get(entry.id) !== entry.turn &&
      (at >= tail || record.mirror.holds(MAIN_AGENT_ID, turnId(entry.turn)))
    )
  }

  /*
   * 收尾：把「屏幕上现在有哪些格」记成这一帧的样子。
   *
   * 三件事各有理由 —— 都要按**位置**判，不能按「这一帧见过谁」：
   * 1. 没变的格子继续留着：换过的上面已经重铺，没换的更不能忘 —— 忘了它的轮号一被复用，
   *    那张表就会替新的一格说谎；
   * 2. 上一帧有、这一帧没了的格要撤下来（压缩把它们合并掉了），但**窗口之外的除外**：
   *    往上翻出去的老历史本来就不在这一帧的 turns 里，它不是「没了」；
   * 3. 窗口之外、这一帧也没重铺的格从这里忘掉：屏幕窗口有上限，翻出去的页由客户端拿着。
   */
  function restage(
    record: Session,
    turns: readonly ScreenTurn[],
    changed: readonly ScreenTurn[],
    tail: number,
    ops: TranscriptOperation[],
  ): void {
    const live = new Set(turns.map((entry) => entry.id))

    for (const [id, ordinal] of record.screen) {
      if (!live.has(id) && ordinal >= tail) {
        ops.push({ op: 'items.remove', ids: [turnId(ordinal)] })
      }
    }

    record.screen.clear()

    for (const [id, ordinal] of stagedAfter(record, turns, changed, tail)) {
      record.screen.set(id, ordinal)
    }
  }

  /** 这一帧之后，屏幕上还留着哪些格（键序与轮号同序：翻页来的那些行按编号入座）。 */
  function stagedAfter(
    record: Session,
    turns: readonly ScreenTurn[],
    changed: readonly ScreenTurn[],
    tail: number,
  ): Map<string, number> {
    const rewritten = new Set(changed.map((entry) => entry.id))
    const staged = new Map<string, number>()

    for (const [at, entry] of turns.entries()) {
      const held = record.screen.get(entry.id)

      if (held !== undefined || rewritten.has(entry.id) || at >= tail) {
        staged.set(entry.id, entry.turn)
      }
    }

    return staged
  }

  /*
   * 一格的 ops：压缩那一条是标记，其余按消息角色铺成一轮。
   *
   * 全是纯构帧，不碰投影器的流式状态 —— 轮号由显示经过的位置给，不由流式累加器给。
   */
  function screenOps(record: Session, entry: ScreenTurn): TranscriptOperation[] {
    return entry.opening.role === 'compactionSummary'
      ? compactionOps(record, entry)
      : turnOps(entry)
  }

  /*
   * 压缩那一格。
   *
   * **号按轮走**（`compaction-<轮号>`）：压缩点固定在那条 `compactionSummary` 消息的位置上，
   * 所以它天然是稳定号，live 的开门/关门两次 upsert 也落在同一格上。
   */
  function compactionOps(record: Session, entry: ScreenTurn): TranscriptOperation[] {
    /* 压缩的统计量住在会话 entry 上（显示经过里那条消息只有正文）。 */
    const compaction = record.agent.sessionManager
      .getBranch()
      .findLast((item) => item.type === 'compaction') as
      | { readonly tokensBefore?: unknown; readonly tokensAfter?: unknown }
      | undefined
    const message = entry.opening as { readonly summary?: unknown }
    const payload: Record<string, unknown> = {
      /* 正在压的那一次：开门事件已经报过 running，别把它说成成了。 */
      state: record.compacting === null ? 'completed' : 'running',
    }

    if (typeof message.summary === 'string' && message.summary !== '') {
      payload['summary'] = message.summary
    }

    if (typeof compaction?.tokensBefore === 'number') {
      payload['tokensBefore'] = compaction.tokensBefore
    }

    if (typeof compaction?.tokensAfter === 'number') {
      payload['tokensAfter'] = compaction.tokensAfter
    }

    return markerOp({
      markerId: `compaction-${String(entry.turn)}`,
      marker: 'compaction',
      at: entry.openedAt,
      payload,
    })
  }

  /*
   * 一轮显示经过 → 它的全部 ops。
   *
   * 一轮 = 开场那句人话 + 模型跑过的每一趟（正文、思维链、工具调用）。每一趟各占一个段，
   * 与增量那条路的排法一致；工具结果并回发起它的那一次调用（同一段同一帧）。
   *
   * 时间必须给成**真实的一对**（开场时刻 → 最后一步时刻）：封条按 `endedAt - startedAt`
   * 算「已处理多久」，两头都填同一个时刻就是一行「已处理 0 秒」。
   */
  function turnOps(entry: ScreenTurn): TranscriptOperation[] {
    const turn = turnId(entry.turn)
    const ops: TranscriptOperation[] = [
      turnOp(entry),
      ...imagesOf(contentOfMessage(entry.prompt), entry.openedAt).flatMap((image) => image.ops),
    ]
    let step = 0

    for (const message of entry.steps) {
      const at = stampOf(message)
      const blocks = contentOf(message)
      let frame = 0

      if (blocks.length === 0) {
        continue
      }

      ops.push(stepOp(turn, step, 'completed', at, at))

      for (const block of blocks) {
        if (block.kind === 'tool') {
          /*
           * 一次工具调用占一个新段：入参与结果分成两段会被投影层认成两次调用
           * （同一个 toolCallId 在两段里各出现一次）。
           */
          if (frame > 0) {
            step += 1
            frame = 0
            ops.push(stepOp(turn, step, 'completed', at, at))
          }

          ops.push(toolOp(turn, step, block, entry.results.get(block.callId)))
          continue
        }

        ops.push(frameOp(turn, step, frame, block))
        frame += 1
      }

      step += 1
    }

    /*
     * 只有**最后一个段**能在跑着的时候留 running（其余一律封口）：段永远停在进行中，
     * 屏幕上那一行就一直转 —— 那正是「已处理 0 秒」旁边还挂着一个转圈的来源。
     */
    return entry.state === 'running' ? markLastStepRunning(ops, turn) : ops
  }

  /** 把最后那一条段 upsert 改成 running（收尾补一次，铺的时候还不知道谁最后）。 */
  function markLastStepRunning(ops: TranscriptOperation[], turn: string): TranscriptOperation[] {
    const at = ops.findLastIndex((op) => op.op === 'step.upsert' && op.turnId === turn)

    if (at < 0) {
      return ops
    }

    return ops.map((op, index): TranscriptOperation => {
      if (index !== at || op.op !== 'step.upsert') {
        return op
      }

      /* 在跑的段没有终点：留一个过去的时刻就是「已处理 0 秒」旁边还转着圈。 */
      const { endedAt: _dropped, ...step } = op.step

      return { ...op, step: { ...step, state: 'running' } }
    })
  }

  /*
   * 一轮的开场：人那句话说一遍，图片先落（投影层按号查附件）。
   *
   * 号与正文由这里写死：`userTurn` 自己按投影器的计数器连着排，而屏幕上的号是「第几轮」
   * （中间隔着工具结果与摘要各占的趟）。照它的号铺，翻一页老内容就会把新内容盖掉。
   */
  function turnOp(entry: ScreenTurn): TranscriptOperation {
    return {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: turnId(entry.turn),
        ordinal: entry.turn,
        state: entry.state,
        origin: { kind: 'user' },
        ...(entry.prompt === null ? {} : { prompt: textOf(contentOfMessage(entry.prompt)) }),
        startedAt: entry.openedAt,
        ...(entry.endedAt === null ? {} : { endedAt: entry.endedAt }),
      },
    }
  }

  /** 一条消息的正文内容（列表或字符串）。 */
  function contentOfMessage(message: AgentMessage | null): unknown {
    return message === null ? '' : (message as { readonly content?: unknown }).content
  }

  function stepOp(
    turn: string,
    ordinal: number,
    state: 'running' | 'completed',
    startedAt: string,
    endedAt: string,
  ): TranscriptOperation {
    return {
      op: 'step.upsert',
      turnId: turn,
      step: {
        kind: 'step',
        stepId: stepId(turn, ordinal),
        turnId: turn,
        ordinal,
        state,
        startedAt,
        endedAt,
      },
    }
  }

  function frameOp(
    turn: string,
    step: number,
    frame: number,
    block: Extract<ScreenBlock, { kind: 'text' | 'thinking' }>,
  ): TranscriptOperation {
    const id = frameId(stepId(turn, step), frame)

    return {
      op: 'frame.upsert',
      turnId: turn,
      stepId: stepId(turn, step),
      frame:
        block.kind === 'text'
          ? { kind: 'text', role: 'assistant', frameId: id, text: block.text }
          : { kind: 'thinking', frameId: id, text: block.text },
    }
  }

  /*
   * 一次工具调用：**调用与结果同一帧**（同一个 frameId 的两次 upsert），中间那段
   * `state` 从 running 走到 done/error。
   *
   * details 必须带上：edit 路径与新旧正文、read 原始正文、todo 清单都在那里。
   */
  function toolOp(
    turn: string,
    step: number,
    block: Extract<ScreenBlock, { kind: 'tool' }>,
    result: ScreenResult | undefined,
  ): TranscriptOperation {
    return {
      op: 'frame.upsert',
      turnId: turn,
      stepId: stepId(turn, step),
      frame: {
        kind: 'tool',
        frameId: `tool.${block.callId}`,
        toolCallId: block.callId,
        name: block.name,
        state: result === undefined ? 'running' : result.isError ? 'error' : 'done',
        input: block.arguments,
        ...(result === undefined
          ? {}
          : {
              output: { content: result.content, details: result.details },
              ...(result.isError ? { error: textOf(result.content) } : {}),
            }),
      },
    }
  }

  type ScreenBlock =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'thinking'; readonly text: string }
    | {
        readonly kind: 'tool'
        readonly callId: string
        readonly name: string
        readonly arguments: unknown
      }

  function contentOf(message: AgentMessage): readonly ScreenBlock[] {
    const content = (message as { readonly content?: unknown }).content

    if (typeof content === 'string') {
      return content === '' ? [] : [{ kind: 'text', text: content }]
    }

    if (!Array.isArray(content)) {
      return []
    }

    const blocks: ScreenBlock[] = []

    for (const block of content as readonly Record<string, unknown>[]) {
      const parsed = blockOf(block)

      if (parsed !== undefined) {
        blocks.push(parsed)
      }
    }

    return blocks
  }

  /* 一个内容块：屏幕上认得的那三种之外一律不画（图片另走 imagesOf）。 */
  function blockOf(block: Record<string, unknown>): ScreenBlock | undefined {
    const kind = block['type']

    if (kind === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      return { kind: 'text', text: block['text'] }
    }

    if (kind === 'thinking' && typeof block['thinking'] === 'string' && block['thinking'] !== '') {
      return { kind: 'thinking', text: block['thinking'] }
    }

    if (kind === 'toolCall' && typeof block['id'] === 'string' && block['id'] !== '') {
      return {
        kind: 'tool',
        callId: block['id'],
        name: typeof block['name'] === 'string' ? block['name'] : '',
        arguments: block['arguments'],
      }
    }

    return undefined
  }

  const stampOf = (message: AgentMessage): string =>
    typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
      ? new Date(message.timestamp).toISOString()
      : new Date().toISOString()

  /*
   * 子代理总线要的那一面。
   *
   * 与 pi-tui 的 `EventBusLike` 同形（on 交回退订函数），但**不从上游 import**：
   * 那是 omp 的内部类型，而我们只用到这一个方法 —— 抄一份接口比绑一个内部模块稳定。
   */
  interface EventBusLike {
    readonly on: (channel: string, listener: (data: unknown) => void) => () => void
  }

  /* 正文帧只装文字：图片块另走 `attachmentOp`（回放历史时由 `imagesOf` 挑出来）。 */
  function textOf(value: unknown): string {
    if (typeof value === 'string') {
      return value
    }

    if (!Array.isArray(value)) {
      return ''
    }

    return (value as readonly { readonly type?: unknown; readonly text?: unknown }[])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
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
    content: unknown,
    stamp: string,
  ): { readonly attachmentId: string; readonly ops: TranscriptOperation[] }[] {
    if (!Array.isArray(content)) {
      return []
    }

    const out: { attachmentId: string; ops: TranscriptOperation[] }[] = []

    for (const [index, value] of content.entries()) {
      const block = value as {
        readonly type?: unknown
        readonly data?: unknown
        readonly mimeType?: unknown
      }

      if (block.type !== 'image' || typeof block.data !== 'string' || block.data === '') {
        continue
      }

      const mediaType = typeof block.mimeType === 'string' ? block.mimeType : 'image/png'
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

  /*
   * 一次现场发送。附件在线上是磁盘绝对路径 + kind（protocol.ts 的 `attachments`），而
   * omp 的 prompt 只认模型就绪的 `ImageContent`（agent-session-types.ts:345），所以图片
   * 由这里读盘转 base64，同官方 CLI（cli/file-processor.ts:104-133）。读盘失败必须抛：
   * 静默丢一张图正是这条命令原来的缺陷（图既不进上下文也不进记录，屏幕上什么都没有），
   * 抛出去至少落成一次 failed 轮终。独立成函数是让 dispatch 主干不超复杂度闸门，与 deltaOps 同理。
   *
   * 同步返回：这一轮**不在这里 await**（为什么见下）。读盘与落 upsert 仍是同步做完的，
   * 所以「命令受理」时那几条 ops 已经发出去了。
   */
  async function sendPrompt(command: Extract<BridgeCommand, { type: 'prompt' }>): Promise<unknown> {
    const record = required()
    const images = readPromptImages(command.attachments)
    const imagePaths = command.attachments
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment) => attachment.path)
    /* 号必须跨消息唯一：`promptId` 是提交时签的，同一条消息里再按序数排开。 */
    const attachmentIds = imagePaths.map(
      (_, index) => `prompt:${command.promptId}:${String(index)}`,
    )

    /*
     * 先落 upsert 再落引用它的 turn：反过来的话投影层先看到 turn，那一格引用一个还不存在
     * 的附件，屏幕上就是一块空白。重开一条会话时铺显示经过（`syncScreen`）也是这个顺序。
     */
    for (const [index, image] of images.entries()) {
      pushTranscript(
        record,
        attachmentOp({
          attachmentId: attachmentIds[index] as string,
          mediaType: image.mimeType,
          dataUrl: `data:${image.mimeType};base64,${image.data}`,
          name: path.basename(imagePaths[index] as string),
        }),
      )
    }

    pushTranscript(
      record,
      record.projector.userTurn(
        command.text,
        attachmentIds,
        command.promptId,
        undefined,
        undefined,
        command.skills,
      ),
      true,
    )

    /* 这一轮的号：轮终迟到时靠它认出「这还是不是我当时那一轮」。 */
    const ordinal = record.projector.turnOrdinal

    /*
     * **不 await 这一轮**：`AgentSession.prompt()` 要等整轮跑完才 resolve —— 它一路
     * await 到 agent loop 的 `agent_end` 与 `#waitForPostPromptRecovery`
     * （agent-session.ts:6373 → 7071 → 4140）。轮里只要有东西在等人，它就永远不 resolve：
     * ask 工具把这一轮卡在 `askDialog` 上（tools/ask.ts:942），而 `ask` 不是 interruptible
     * 工具，排队插话也砍不动它（agent-loop.ts:2900-2908）。
     *
     * 于是「等这一轮跑完再回应答」= 提问那一刻起回执永远不来，Rust 侧投递永远停在
     * Pending/Unknown，界面报「投递结果未确认」，再发一句又被 UnsafeReplay 挡住。
     *
     * 官方 RPC 模式对同一件事的判词是 `// Don't await - events will stream`
     * （modes/rpc/rpc-mode.ts:1234）：命令受理与轮次完成是两件事，回执只说前者，
     * 后者由事件流报（agent_end → 本层的 `turn_end`）。本层照此办理。
     *
     * 起不了一轮（模型/钥匙缺失、AgentBusyError）时没有 agent_end 可等，所以在这里
     * 就地补一条轮终 —— Rust 靠它收账，否则那一笔永远欠着。
     */
    /*
     * 挂了技能：走官方的展开路径，不是把字面命令丢给模型。
     *
     * 上游 `AgentSession.prompt()` **自己不解析** `/skill:` —— 全包只有 CLI、RPC、ACP、
     * task 四处调 `parseSkillInvocation`，而它们都走 `promptCustomMessage`。所以我们
     * 从前把 command.text 原样交出去时，模型收到的是字面 `/skill:review`，技能根本没跑。
     *
     * 照官方 RPC 宿主那 17 行写（modes/rpc/rpc-mode.ts:157-174）：查会话自己的技能表 →
     * `buildSkillPromptMessage` 读出 SKILL.md 并渲染模板 → `promptCustomMessage` 带
     * `SKILL_PROMPT_MESSAGE_TYPE` 投递。不自己发明格式、不自己读盘。
     *
     * 一次提交挂多枚 chip 时投一条消息、正文按顺序拼：`promptCustomMessage` 一次只投一条，
     * 而多个技能本来就是「同一句话带上的几份上下文」，拆成几条会变成几轮。
     */
    const skills = command.skills ?? []
    /*
     * 展开要 await（要读 SKILL.md），投递不能 await（见下面那段注释）—— 所以先展开，
     * 再拿结果去开轮。没有技能时这一步是空转。
     */
    const expanded = skills.length === 0 ? undefined : await expandSkills(record, skills)
    const prompt =
      expanded === undefined
        ? record.agent.prompt(command.text, images.length === 0 ? undefined : { images })
        : record.agent.promptCustomMessage(customSkillMessage(expanded, images), {
            streamingBehavior: 'steer',
          })

    void prompt
      .then((forwarded) => {
        /* false = 上游把这句话就地处理掉了（斜杠命令），这一轮不会有 agent_end。 */
        if (!forwarded) {
          settleUnstartedTurn(record, ordinal, 'completed')
        }
      })
      .catch((error: unknown) => {
        /*
         * 竞态：投递这一刻这一轮已经开跑了（界面上还是空闲，事件还没到）。上游对
         * 「流式中调 prompt 且没带 streamingBehavior」的处理是抛 AgentBusyError
         * （agent-session.ts:6467），照原样报错就等于把用户这句话吞掉。
         *
         * omp 自己的 TUI 用「空闲路径也带 streamingBehavior: 'steer'」绕开它
         * （input-controller.ts:1219-1229）。我们绕不开：那一格会把这句悄悄排进
         * steer 队列，而本机账本与乐观帧都按「这一轮开起来了」记的账。所以这里
         * 明着补一次插话，并把那一轮如实收成失败 —— 话不丢，账也不假。
         */
        if (isBusy(error)) {
          void record.agent
            .steer(command.text, images.length === 0 ? undefined : images)
            .then(() => {
              record.injections.push({ text: command.text, deliverAs: 'steer' })
              settleUnstartedTurn(
                record,
                ordinal,
                'failed',
                '这一句投递时那一轮已经开跑，已改按插话送进正在跑的那一轮。',
              )
            })
            .catch((retry: unknown) => {
              settleUnstartedTurn(record, ordinal, 'failed', messageOf(retry))
            })
          return
        }

        settleUnstartedTurn(record, ordinal, 'failed', messageOf(error))
      })

    return {}
  }

  /*
   * 三层插话的投递。与 `turn` 分开写，因为两者的「受理」含义不同：
   *
   * - `turn` 受理 = 开了一轮，本机账本等的是轮终（sendPrompt 走的是那条路）；
   * - 插话受理 = **agent 收下了**（上游三个调用都返回 void，收下即回执）。所以这一条
   *   要 await：拒绝（扩展命令、会话已 dispose）必须如实传上去，不能假装排上了。
   *
   * 附件照 `turn` 那条路读盘成 base64（`readPromptImages`），三层都收 images。
   */
  async function deliverInterjection(
    record: Session,
    command: Extract<BridgeCommand, { type: 'prompt' }>,
    deliverAs: 'steer' | 'followUp',
  ): Promise<unknown> {
    const images = readPromptImages(command.attachments)
    const carried = images.length === 0 ? undefined : images

    const skills = command.skills ?? []

    if (skills.length > 0) {
      /*
       * 插话也挂了技能：同样走官方展开，不能把字面 /skill: 排进队列。
       *
       * 认领账本记的是**展开前**的正文（record.injections 按文本认领注入消息），
       * 而注入进来的将是展开后的正文 —— 两者对不上。所以这里把**展开后**的正文
       * 记进去：message_start 到的就是它（与 turn 那条路「投影写原文、投递写展开文」
       * 不同，因为插话的正文完全由 agent 决定，我们只认它报回来的那一句）。
       */
      const expanded = await expandSkills(record, skills)

      await record.agent.promptCustomMessage(customSkillMessage(expanded, images), {
        streamingBehavior: deliverAs,
        queueChipText: command.text,
      })
      record.injections.push({ text: expanded.text, deliverAs })
      emitQueue(record)

      return {}
    }

    if (deliverAs === 'steer') {
      await record.agent.steer(command.text, carried)
    } else {
      await record.agent.followUp(command.text, carried)
    }

    record.injections.push({ text: command.text, deliverAs })
    emitQueue(record)

    return {}
  }

  /*
   * 队列此刻的事实。两层待发正文与三个模式都从 agent 自己的读法来（agent-session.ts
   * 的 getQueuedMessages / steeringMode / followUpMode / interruptMode），本层不记副本。
   *
   * 上游的第三档 `aside` 不在这一份快照里，本仓也不接它：上游没有读它的 API，本机
   * 无从知道它何时被吃掉 —— 画出来的行会永远留在屏幕上（ADR 0034）。
   */
  function queueOf(record: Session): QueuedState {
    const queued = record.agent.getQueuedMessages()

    return {
      sessionId: record.id,
      steering: [...queued.steering],
      followUp: [...queued.followUp],
      steeringMode: record.agent.steeringMode,
      followUpMode: record.agent.followUpMode,
      interruptMode: record.agent.interruptMode,
    }
  }

  /*
   * 推一次队列快照。
   *
   * 上游没有队列变更事件，所以推送点由这里认：投递插话、撤回、改模式、轮终、取消，
   * 以及**注入消息的 message_start**（模型真的看见了那句话，chip 该消失）。
   */
  function emitQueue(record: Session): void {
    emit({ kind: 'queue', sessionId: record.id, queue: queueOf(record) })
  }

  /*
   * 轮终/取消时，把已经不可能再露面的插话从认领账本里摘掉。
   *
   * 判据只有一条：**agent 此刻还排着它吗**。还排着就留着 —— 外部 abort 与「人按过
   * 停止」都刻意不排空队列（agent-loop.ts:1637-1643 的 `signal?.aborted` 分支、
   * agent-session.ts 的 #canAutoContinueForFollowUp），那句话等下一次显式提交、在
   * 那一轮的起点才被注入；先摘掉它，`message_start` 到的时候就没有认领对象，屏幕上
   * 那句话再也画不出来，队列 chip 也永远不消失。
   *
   * 不排着的到此为止：撤回过、被上游丢弃的，都不会再有帧。
   *
   * 正文比对**只用作认领回退**：`deliverAs: 'turn'` 的开场白也走 `message_start`，
   * 它不在这个账本里，所以不会被误认。
   */
  function forgetInjected(record: Session): void {
    const queued = record.agent.getQueuedMessages()
    const waiting: readonly string[] = [...queued.steering, ...queued.followUp]
    const still = record.injections.filter((entry) => waiting.includes(entry.text))

    record.injections.length = 0
    record.injections.push(...still)
  }

  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  /*
   * 是不是「agent 正在跑」那一条。按名字认而不是 import 上游的类：那是 pi-agent-core
   * 的东西，SDK 根导出面里没有它（index.ts 只挑了几样）；名字是上游自己设的
   * （agent.ts:94-101 的 `this.name = "AgentBusyError"`）。
   */
  const isBusy = (error: unknown): boolean =>
    error instanceof Error && error.name === 'AgentBusyError'

  /*
   * 一轮没能起来：就地补轮终。
   *
   * 只认自己那一轮 —— 迟到的 catch 可能落在一个**新**轮上（取消之后人又发了一句），
   * 那时把新轮收掉就是把别人的话掐了。轮号对不上就不动。
   */
  function settleUnstartedTurn(
    record: Session,
    ordinal: number,
    outcome: 'completed' | 'failed',
    message?: string,
  ): void {
    if (record.projector.turnOrdinal !== ordinal) {
      return
    }

    const ops = record.projector.turnEnd(outcome, message)

    /* 已经收过的轮返回空表（投影器自己判 #turnOpen）：真 agent_end 报过就不再报第二遍。 */
    if (ops.length === 0) {
      return
    }

    pushTranscript(record, ops, true)
    emit({
      kind: 'turn_end',
      sessionId: record.id,
      outcome,
      ...(message === undefined ? {} : { message }),
    })
  }

  /*
   * 盘上的附件 → omp 认的图片；分派判据与 mime 产地见 protocol.ts 的 `attachments`
   * （kind 与 mime 都以线上那一格为准，不嗅第二遍、不按扩展名反推）。`kind: 'file'`
   * 的路径原样留给 agent 的 Read 工具。上限与 protocol.ts 的 MAX_FRAME_BYTES 同源：
   * 这一格既是 agent 的输入，也是我们推出去的最大单条 op（内联图）。
   */
  function readPromptImages(
    attachments: Extract<BridgeCommand, { type: 'prompt' }>['attachments'],
  ): PromptImage[] {
    const images: PromptImage[] = []

    for (const attachment of attachments) {
      if (attachment.kind !== 'image') {
        continue
      }

      const size = fs.statSync(attachment.path).size

      if (size > MAX_PROMPT_IMAGE_BYTES) {
        throw new Error(
          `attachment too large: ${attachment.path} is ${String(size)} bytes, limit ${String(MAX_PROMPT_IMAGE_BYTES)}`,
        )
      }

      const data = fs.readFileSync(attachment.path).toString('base64')

      /* 带上落盘路径：SDK 靠这个符号注入隐藏的 image-attachment 伴生消息，agent 于是
       * 既拿到像素，也拿到能 `read`、能上传的那个路径（agent-session.ts:6291-6311）。 */
      images.push(
        tagImageAttachmentSource(
          { type: 'image', data, mimeType: attachment.mime },
          attachment.path,
          'image',
        ),
      )
    }

    return images
  }

  /*
   * 增量正文只有两种：说话的那一段与想的那一段。其余内部事件不上屏。
   *
   * 独立成函数是因为它要把 `assistantMessageEvent` 那个判别式联合收窄一次；留在
   * handleEvent 里会让那一个主干的分支数超限（biome 的复杂度闸门按分支数算）。
   */
  function deltaOps(
    project: TranscriptProjector,
    inner: AssistantDelta,
  ): ReturnType<TranscriptProjector['textDelta']> {
    switch (inner.type) {
      case 'text_delta':
        return project.textDelta(inner.delta)
      case 'thinking_delta':
        return project.thinkingDelta(inner.delta)
      default:
        return []
    }
  }

  /*
   * 一次工具调用开始。记下 ask 的调用号：那组题要挂回它下面。
   *
   * omp 的 askDialog 不带这个号（tools/ask.ts:800 的 `execute(_toolCallId, …)` 收得到
   * 却没往下传），而 `tool_execution_start` 带着。`ask` 在 omp 里是 exclusive
   * （同时至多一个在飞），所以「最近一次」没有歧义。
   *
   * 独立成函数与 deltaOps 同理：那一句判断留在 handleEvent 里会让它的分支数超限。
   */
  function toolStartOps(
    record: Session,
    event: Extract<AgentSessionEvent, { type: 'tool_execution_start' }>,
  ): ReturnType<TranscriptProjector['toolStart']> {
    if (event.toolName === ASK_TOOL) {
      record.askCallId = event.toolCallId
    }

    return record.projector.toolStart({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      ...(event.intent === undefined ? {} : { intent: event.intent }),
    })
  }

  /*
   * 挂了技能的那一句话：走官方的展开路径。
   *
   * 上游把「技能 → 消息」这件事只做在一个地方（extensibility/skills.ts 的
   * buildSkillPromptMessage：读 SKILL.md、剥 frontmatter、渲染 userInvocationTemplate），
   * 四个宿主各自调它。我们自己读盘拼正文就是第二套格式，而模板是上游的、会变。
   *
   * 名字对不上会话自己的技能表时**不静默**：那一枚 chip 指着一个此刻不存在的技能，
   * 报错比把字面命令送进模型好（后者是「看起来跑了其实没跑」）。
   *
   */
  async function expandSkills(
    record: Session,
    skills: readonly { readonly name: string; readonly args?: string }[],
  ): Promise<{
    readonly first: BuiltSkillPrompt
    readonly blocks: readonly BuiltSkillPrompt[]
    readonly text: string
  }> {
    const known = new Map(record.agent.skills.map((skill) => [skill.name, skill]))
    const blocks: BuiltSkillPrompt[] = []

    for (const wanted of skills) {
      const skill = known.get(wanted.name)

      if (skill === undefined) {
        throw new Error(`这个技能现在不在会话里：${wanted.name}`)
      }

      blocks.push(await buildSkillPromptMessage(skill, { args: wanted.args ?? '' }, 'user'))
    }

    /* 调用方只在 skills 非空时进来，所以第一份一定在；取它一次，省掉下游的断言。 */
    const [first] = blocks

    if (first === undefined) {
      throw new Error('一次技能提交里没有任何技能')
    }

    /* 拼法与 textOf 同一条（text 块之间用 \n）：注入回来时认领账本按它比对。 */
    return { first, blocks, text: blocks.map((block) => block.message).join('\n') }
  }

  /*
   * 把展开好的技能交给 agent。正文块要写成 TextContent：customMessage 的 content 是
   * 「文本块 + 图片」的联合数组，而 prompt() 的 content 收裸字符串（两条签名不一样）。
   *
   * details 原样带上游那一份（SkillPromptDetails）：自造一个形状会让渲染层认不出这是
   * 技能消息。多个技能时取第一份 —— 上游一次只投一条消息，details 也只有一份的位置。
   */
  function customSkillMessage(
    expanded: { readonly first: BuiltSkillPrompt; readonly blocks: readonly BuiltSkillPrompt[] },
    images: readonly PromptImage[],
  ) {
    return {
      customType: SKILL_PROMPT_MESSAGE_TYPE,
      content: [
        ...expanded.blocks.map((block) => ({ type: 'text' as const, text: block.message })),
        ...images,
      ],
      display: true,
      details: expanded.first.details,
      attribution: 'user' as const,
    }
  }

  /*
   * 工具的中间结果。
   *
   * 官方为宿主专门发这一条：bash 的 tail 按 50ms 节流（bash-executor.ts:517）、
   * edit 的实时 diff 走 openArgStream（agent-loop.ts:2101-2115）。从前它落进
   * handleEvent 的 default 被整条丢掉 —— 长工具在屏幕上是「运行中」直接跳终态。
   *
   * partialResult 与 update 是两种形状，都当成 output 的中间值：投影层不解释它，
   * 渲染层按工具自己的类别读（与终态的 output 同一条路）。
   */
  function toolUpdateOps(
    record: Session,
    toolCallId: string,
    toolName: string,
    partial: unknown,
  ): ReturnType<TranscriptProjector['toolUpdate']> {
    return record.projector.toolUpdate({ toolCallId, toolName, partial })
  }

  /*
   * 插话落地。
   *
   * 三层插话最终都走同一条上游事件：注入的消息被折进上下文时发
   * message_start/message_end（agent-loop.ts:1092-1097 的 emitInputMessages）。
   * 开场那句 prompt 也发同一对事件，所以判据是「这条正文是不是我投出去还没认领的
   * 那一条」（见 Session.injections）。
   *
   * 认领后怎么画由投影器自己判：开着一轮就是这一轮里的一句插话，没开一轮
   * （followUp 在轮终之后被排成下一轮）就是这句话自己开一轮。
   *
   * 没认领的返回 null：场面上什么都没发生，调用方按空 ops 走。
   */
  function claimedInjection(
    record: Session,
    message: Extract<AgentSessionEvent, { type: 'message_start' }>['message'],
  ): ReturnType<TranscriptProjector['turnEnd']> | null {
    if (message.role !== 'user' || !('content' in message)) {
      return null
    }

    const content = message.content
    const text = textOf(content)
    const at = record.injections.findIndex((pending) => pending.text === text)

    if (at < 0) {
      return null
    }

    const [claimed] = record.injections.splice(at, 1)
    const stamp = iso(message.timestamp)
    const images = imagesOf(content, stamp)

    return [
      ...images.flatMap((image) => image.ops),
      ...record.projector.steeredFrame(
        claimed?.text ?? text,
        images.map((image) => image.attachmentId),
        stamp,
      ),
    ]
  }

  /* 一次重投影交回的两样：要推出去的 ops，以及显示经过最老那一格的号。 */
  interface ScreenFrame {
    readonly ops: readonly TranscriptOperation[]
    readonly floor: string | undefined
  }

  /*
   * 顺序即不变量：增量先落地，重投影后到 —— 重投影会把同一格整轮换掉。
   * 所以这一步在那一批 ops 之后、轮终之前（轮终要等这一轮写下的东西都到齐）。
   */
  function repaintScreen(record: Session, needed: boolean): void {
    if (!needed) {
      return
    }

    const frame = syncScreen(record)

    /* 游标存的是显示经过最老那一格：往回翻到底时页要如实说没有更早的了。 */
    record.floor = frame.floor
    pushTranscript(record, frame.ops, true)
  }

  /*
   * 压缩开门那一格。号是「屏幕上下一格」：显示经过里压缩为第 n 条消息，而投影器手上的
   * 轮号就是屏幕上已有的轮数 —— 开门与关门于是落在同一格上，收尾时 syncScreen 也落回同一格。
   */
  function compactionOpened(record: Session): TranscriptOperation[] {
    record.compacting = { markerId: `compaction-${String(record.projector.turnOrdinal + 1)}` }

    return markerOp({
      markerId: record.compacting.markerId,
      marker: 'compaction',
      payload: { state: 'running' },
    })
  }

  /*
   * 压缩关门那一格。号只作落点：取此刻正在压的那一个；真没有就现起一个（比如中途接上
   * 一条已在压的会话），总比丢掉强。
   */
  function compactionClosed(
    record: Session,
    event: Extract<AgentSessionEvent, { type: 'auto_compaction_end' }>,
  ): TranscriptOperation[] {
    const markerId =
      record.compacting?.markerId ?? `compaction-${String(record.projector.turnOrdinal + 1)}`

    record.compacting = null

    return markerOp({ markerId, marker: 'compaction', payload: compactionEnded(event) })
  }

  /*
   * 一轮收尾那一下：增量那条路的收尾 ops，加上代表它的终局。
   *
   * 轮号在重投影之后由 `seatOf` 补上（见 handleEvent 尾部）：号要按**压缩后**的显示经过算，
   * 而这一刻它还是压缩前的。
   */
  function tickEnded(record: Session): {
    readonly ended: TranscriptOperation[]
    readonly outcome: TurnOutcome
  } {
    forgetInjected(record)

    const last = record.agent.getLastAssistantMessage()
    const outcome = outcomeOf(last)

    return {
      ended: record.projector.turnEnd(outcome.kind, outcome.message, undefined, usageOf(last)),
      outcome,
    }
  }

  /*
   * 这一条事件产出的 ops 推出去。
   *
   * **重投影要排在增量前面**（见本函数尾部）：重投影铺的是显示经过的权威形状（一整轮
   * 一起换），而增量写的是同一轮的实时逐帧 —— 反过来会把刚写下的那几个字一起盖掉。
   */
  function emitNow(record: Session, produced: readonly TranscriptOperation[]): void {
    if (produced.length > 0) {
      pushTranscript(record, produced)
    }
  }

  /* 一次工具调用的收尾：入参与结果同一帧（投影器按 toolCallId 记着入参）。 */
  function toolEndOps(
    project: TranscriptProjector,
    event: Extract<AgentSessionEvent, { type: 'tool_execution_end' }>,
  ): TranscriptOperation[] {
    return project.toolEnd({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      ...(event.isError === undefined ? {} : { isError: event.isError }),
    })
  }

  function handleEvent(record: Session, event: AgentSessionEvent): void {
    const project = record.projector
    let ending: TurnOutcome | null = null
    /* 轮终那几条 ops：重投影之后才推，号按重投影算出来的位置补。 */
    let ended: TranscriptOperation[] = []

    /*
     * 这一轮收尾后要不要拿显示经过对一遍屏幕（见 syncScreen）。
     *
     * 只在两处为真：轮终（这一轮在显示经过里成型了）与压缩收尾（更早的 entry 被换掉了）。
     * 流式帧期间不跑：那时候显示经过还没变，白读一遍整条会话。
     */
    let repaint = false

    switch (event.type) {
      case 'turn_start':
        // 用户那一轮由 prompt 命令开，这里只接 agent 自己的 turn。
        break

      case 'message_start':
        emitNow(record, claimedInjection(record, event.message) ?? [])
        emitQueue(record)
        break

      case 'message_update':
        emitNow(record, deltaOps(project, event.assistantMessageEvent))
        break

      case 'tool_execution_start':
        emitNow(record, toolStartOps(record, event))
        break

      case 'tool_execution_end':
        emitNow(record, toolEndOps(project, event))
        break

      /*
       * 工具的中间结果。两条上游事件都接：execution_update 带 partialResult，
       * stream_update 带 update（edit 的实时 diff）。从前它们落进 default 被丢掉。
       */
      case 'tool_execution_update':
        emitNow(
          record,
          toolUpdateOps(record, event.toolCallId, event.toolName, event.partialResult),
        )
        break

      case 'tool_stream_update':
        emitNow(record, toolUpdateOps(record, event.toolCallId, event.toolName, event.update))
        break

      case 'notice':
        emitNow(record, project.notice(event.level, event.message, event.source))
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
       * 上下文压缩：不绑 turn（压的是上下文，不是某一轮），所以走标记而不是轮里的帧。
       * 「关门事件不带号、号要自己记」见 Session.compacting 字段注释（正本）。
       */
      case 'auto_compaction_start':
        emitNow(record, compactionOpened(record))
        break

      case 'auto_compaction_end':
        emitNow(record, compactionClosed(record, event))
        /*
         * 更早的 entry 刚刚从显示经过里被换掉：屏幕上要跟着改成压缩后的样子。
         * 这一步同时把这一条标记挪到它**真正**的位置上（压缩发生的那一轮）。
         */
        repaint = true
        break
      case 'agent_end': {
        /* isTerminal 为 false 时后面还有活干，这一轮没真结束。 */
        const closed = event.isTerminal === false ? null : tickEnded(record)

        ended = closed?.ended ?? []
        ending = closed?.outcome ?? null
        /* 这一轮在显示经过里成型了：对一遍屏幕。 */
        repaint = closed !== null
        break
      }

      default:
        break
    }

    repaintScreen(record, repaint)

    /*
     * 轮终那几条 ops 在这一批之后推（保序：先把重投影铺完，再把收尾补上）。
     *
     * 轮号不必在这里改：`syncScreen` 已经把累加器坐在屏幕上最新那一轮上（见 `seat`），
     * 所以这一轮开的号与显示经过里它的位置本来就是同一个。
     */
    if (ended.length > 0) {
      pushTranscript(record, ended, true)
    }

    if (ending !== null) {
      // 轮终前 flush 攒批：保证屏幕在 turn_end 事件前已收到全部 ops
      flushTranscript(record)
      emit({
        kind: 'turn_end',
        sessionId: record.id,
        outcome: ending.kind,
        ...(ending.message === undefined ? {} : { message: ending.message }),
      })
      reportUsage(record)
      /* 轮终是队列唯一会自己变短的时刻之一（followUp 被排成下一轮、steer 已被吃掉）。 */
      emitQueue(record)
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
      ...(typeof tokensBefore === 'number' && Number.isFinite(tokensBefore)
        ? { tokensBefore }
        : {}),
    }
  }

  /*
   * 上下文用量的报数。
   *
   * 构成取 omp 自己的 `computeContextBreakdown`（pi-tui 的 status-line/context-usage），
   * 不自己按 `getContextBreakdown` 那五格折：正本把「技能」从系统提示词里减出去、
   * 还算出空闲与自动压缩缓冲，自己折就会与它在屏幕上显示的那份不一致。
   *
   * 那一份的唯一产地是 omp 自己（`computeSessionContextBreakdown` 读它自己的设置），
   * 所以这里连它的 compaction 设置一起读，不在我们这一侧重算阈值。
   */
  function reportUsage(record: Session): void {
    const stats = record.agent.getSessionStats()
    const context = stats.contextUsage
    const breakdown = computeSessionContextBreakdown(record.agent)

    const tokensOf = (id: string): number =>
      breakdown.categories.find((category) => category.id === id)?.tokens ?? 0

    const usage: UsageSnapshot = {
      used: context?.tokens ?? stats.tokens.input,
      size: context?.contextWindow ?? 0,
      inputOther: stats.tokens.input,
      inputCacheRead: stats.tokens.cacheRead,
      inputCacheCreation: stats.tokens.cacheWrite,
      breakdown: {
        systemPrompt: tokensOf('systemPrompt'),
        systemContext: tokensOf('systemContext'),
        systemTools: tokensOf('systemTools'),
        skills: tokensOf('skills'),
        messages: tokensOf('messages'),
        free: breakdown.freeTokens,
        autoCompactBuffer: breakdown.autoCompactBufferTokens,
      },
    }

    emit({ kind: 'usage', sessionId: record.id, usage })
  }

  // 三格各有产地：model 用 session.model + getAvailableModels；
  // thinking 候选**只有这条模型自己的梯子**（上游 getSupportedEfforts，见 thinking.ts）；
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
        choices: levels.map((level) => {
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
        /*
         * 开目标要有正文当 objective，而正文是用户下一句要打的话：收工由 prompt 一起交。
         * 面板照这一格把「目标」画成待提交，不在点的那一刻空手发 set_config（见 selectGoal）。
         */
        appliesOnSubmit: true,
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

  /*
   * 读期望态时用哪个工作区：会话在就说会话的，没有就用宿主启动时的那个。
   *
   * 两个候选都是「这条连接此刻锚在哪」的事实，不另存副本 —— 连接的 cwd 由 Rust 侧
   * spawn 时定下（Command::current_dir），会话自己的 cwd 由 SessionManager 记着。
   */
  function workspaceOf(): string {
    return currentSession()?.agent.sessionManager.getCwd() ?? hydratingCwd ?? host.cwd
  }

  /*
   * 改一格选择器：会话已在手就落会话（`applySelection`，要通知会话），否则落期望态。
   *
   * 先等水合落定再判「有没有会话」：刚开的新对话可能还在水合，不等就会把一条真会话
   * 当成入口态，把改动落到配置上而不是会话对象上。
   *
   * 两条寿命的映射也在这里：模型与权限两格两种寿命都有；计划与目标两格只住会话上，
   * 还没有会话时如实拒绝（`applyExpectedSelection` 认得出，见 expected-state.ts）。
   */
  async function selectControl(
    command: Extract<BridgeCommand, { type: 'select' }>,
  ): Promise<unknown> {
    await settleHydration()

    const record = currentSession()

    if (record !== null) {
      await applySelection(record, command.configId, command.value, command.input ?? null)

      return { controls: await readSelectors(record) }
    }

    await writeExpectedState(command.configId, command.value)

    return { controls: (await readExpectedState(workspaceOf())).controls }
  }

  /*
   * 入口那一屏的三格（选择器、技能、MCP）读一次。
   *
   * 两条寿命各有各的读法：会话已在手就读会话对象（轮次级事实），还没水合完就读期望态
   * （进程级事实）。**刻意不等水合** —— 这三格正是入口要的，等它就等于把水合的钱付在
   * 入口上；水合完成时 adopt 会推一次 selectors，屏幕因此先有值、后精确。
   *
   * 判据收在这里而不是分派里：三格共用同一条寿命规则，写在三处必然有一处先漂移
   * （AGENTS.md §5「单一分发点」）。**不含 MCP 那次握手等待** —— 那一等只对名册有意义，
   * 摊到这里会把选择器与技能一起拖住（见 mcpServersOf）。
   */
  async function entryReadOf(): Promise<{
    controls: readonly SelectorControl[]
    skills: readonly ExpectedSkill[]
    servers: readonly ExpectedServer[]
  }> {
    const record = currentSession()

    if (record === null) {
      return await readExpectedState(workspaceOf())
    }

    return {
      controls: readSelectors(record),
      skills: record.agent.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        source: skillSourceOf(skill.source),
        kind: null,
        disableModelInvocation: skill.hide === true ? true : null,
      })),
      servers: readServers(record),
    }
  }

  /*
   * MCP 名册那一格。
   *
   * 会话在手时多等一次在飞的握手，但必须有截止时间 —— `waitForPendingConnections` 会
   * drain 到所有 pending 握手 settle（omp manager.ts 最多 8 轮），一台连不上的服务器就能
   * 挂住，实测 npx 拉 @playwright/mcp 时这一等是 181 秒。所以等一小会儿，超时就先报此刻
   * 的事实，没连上的那台由下一趟读补齐（会话就绪推 selectors 时名册会重读，见
   * conversation 的 capability-store）。
   *
   * 还没有会话（水合还没完）时读**配置层**：配了哪几台是即时事实，不花那 1.5 秒等一个
   * 还没开始的握手。
   */
  async function mcpServersOf(): Promise<readonly ExpectedServer[]> {
    const record = currentSession()

    if (record === null) {
      return (await readExpectedState(workspaceOf())).servers
    }

    await Promise.race([
      record.mcp?.waitForPendingConnections(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, MCP_HANDSHAKE_GRACE_MS).unref?.()
      }),
    ])

    return readServers(record)
  }

  function required(): Session {
    const record = currentSession()

    if (record === null) {
      throw new Error('no session')
    }

    return record
  }

  /*
   * 要会话对象的那条路：先等在飞的水合再取。
   *
   * `required()` 是同步的（许多地方要用它取引用），而水合现在是异步的 —— 这一步是两者之间
   * 的唯一接缝。调用方必须先 `await settleHydration()` 再调 `required()`，否则刚开的新对话
   * 会读到「没有会话」。reviewable 判据：任何以 `required()` 开头的 case 前面都要有它。
   */
  async function requiredSettled(): Promise<Session> {
    await settleHydration()

    return required()
  }

  function settleDialog(record: Session, requestId: string, payload: unknown): unknown {
    record.desk.settle(requestId, payload as Record<string, unknown>)

    return {}
  }

  // 出去的是 transcript.ops 信封（Rust 原样转 native-bridge 校验），信封与水位的产地在镜像。
  // 攒批：高频 delta（text/thinking）在 16ms 窗口内合并为一次 accept，减少 emit 数与
  // 下游 Rust 序列化/webview IPC/TS 解码的趟数。关键事件（turnEnd、userTurn、interactions）
  // 立即 flush，保证屏幕状态不被延迟。
  const BATCH_WINDOW_MS = 16
  const pendingOps = new Map<string, TranscriptOperation[]>()
  const batchTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function flushTranscript(record: Session): void {
    const sessionId = record.id
    const timer = batchTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      batchTimers.delete(sessionId)
    }
    const buffered = pendingOps.get(sessionId)
    if (buffered === undefined || buffered.length === 0) {
      return
    }
    pendingOps.delete(sessionId)
    pushEnvelopes(record, record.mirror.accept(buffered))
  }

  /*
   * 一批 ops 可能被镜像切成好几行（见 transcript-mirror 的字节预算）：一行一条事件，
   * 按顺序推出去。合成一行就是原来那个顶穿单行上限的缺陷。
   */
  function pushEnvelopes(record: Session, envelopes: readonly unknown[]): void {
    for (const payload of envelopes) {
      emit({ kind: 'transcript', sessionId: record.id, payload })
    }

    const first = envelopes[0] as { readonly payload?: { readonly seq?: number } } | undefined

    /* 断线重连的会合点：先整页重建，再接在这里之后的增量。 */
    if (first?.payload?.seq !== undefined) {
      emit({
        kind: 'transcript',
        sessionId: record.id,
        payload: {
          type: 'transcript.reset',
          payload: { agent_id: MAIN_AGENT_ID, seq: first.payload.seq },
        },
      })
    }
  }

  function pushTranscript(
    record: Session,
    ops: readonly TranscriptOperation[],
    immediate = false,
  ): void {
    if (ops.length === 0) {
      return
    }

    if (immediate) {
      // 先 flush 已攒的，再立即发这批，保序
      flushTranscript(record)
      pushEnvelopes(record, record.mirror.accept(ops))
      return
    }

    const sessionId = record.id
    let buffered = pendingOps.get(sessionId)
    if (buffered === undefined) {
      buffered = []
      pendingOps.set(sessionId, buffered)
    }
    for (const op of ops) {
      buffered.push(op)
    }

    if (!batchTimers.has(sessionId)) {
      batchTimers.set(
        sessionId,
        setTimeout(() => {
          batchTimers.delete(sessionId)
          flushTranscript(record)
        }, BATCH_WINDOW_MS),
      )
    }
  }

  /*
   * 子代理总线的两条订阅。
   *
   * 频道名取自 pi-tui 的 session-observer-registry（omp 的 task/types.ts 正是从那
   * re-export 的），不手抄字面量：抄一份就是第二个事实。
   *
   * 帧形状按结构收窄（subagents.ts 的入参是可选字段），总线上的载荷是 unknown ——
   * 认不出的帧在账里变成空 ops，不猜。
   */
  function subscribeSubagents(record: Session, bus: EventBusLike): () => void {
    const lifecycle = bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data) => {
      projectSubagents(record, record.subagents.lifecycle(data))
    })
    const progress = bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data) => {
      projectSubagents(record, record.subagents.progress(data))
    })

    return () => {
      lifecycle()
      progress()
    }
  }

  function projectSubagents(record: Session, ops: readonly TranscriptOperation[]): void {
    if (ops.length === 0) {
      return
    }

    /* 任务行是独立于轮的整格替换，不攒批：它的节奏由 omp 的 150ms 合并决定，已经够稀。 */
    pushTranscript(record, ops, true)
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
      true,
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
    record.pending.set(requestId, {
      kind: 'question',
      toolName: ASK_TOOL,
      request,
      ...(record.askCallId === null ? {} : { toolCallId: record.askCallId }),
    })

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
        /*
         * 真实的调用号，不是工具名：屏幕靠它把这一格挂回发起它的那次 `ask` 调用下面。
         * 取不到（回放的历史会话）就退成工具名 —— 位置会差，但题本身仍然画得出来。
         */
        toolCallId: record.askCallId ?? ASK_TOOL,
        request: { questions },
      }),
      true,
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
     *
     * `answers` 是**产品形状**的那一份（dispatch 与折好的 value 一起递过来）：
     * 上游那份只认标签，屏幕要按题号读人答了什么，两者形状不同，各留各的。
     */
    const answer = responseOf(payload)
    const answered = answer.cancelled !== true && answer.value !== undefined

    pushTranscript(
      record,
      interactionOp({
        interactionId: requestId,
        kind: 'question',
        state: answered ? 'answered' : 'dismissed',
        toolCallId: held.toolCallId ?? ASK_TOOL,
        request: { questions: questions ?? [] },
        ...(answered && answer.answers !== undefined ? { response: answer.answers } : {}),
      }),
      true,
    )
  }

  /*
   * 一次授权答复 → 结论 + （scope=session 时）会话级放行。本论据的正本：
   * 「本次会话都批准」不是再答一次 —— 上游 select 只有两颗按钮，一次只放行一次；让会话
   * 往后都放行的是 `tools.approval.<tool>: allow` 那条设置，上游 resolveApproval 先查
   * 用户策略（tools/approval.ts:283-291），写走 Settings.set + flush，写进去才算数。
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
      true,
    )
  }

  /* 会话级放行的落点（论据正本见 resolveApproval）。写一次就够，重复写是同一格的第二次赋值，所以记着写过的。 */
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
      true,
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

  /*
   * 本机能力清单。
   *
   * 只有一项：桌面控制。它是 omp 编进来的 eval 前奏（tools/computer 的
   * prelude-definition），没有「安装」这一步 —— 它在不在由构建决定，开不开由
   * `computer.enabled` 决定。所以这里报的是**此刻的就绪**，不是一份目录。
   *
   * `supported` 与 `state` 分开是有意的：前者说这台机器上有没有这块能力（构建事实），
   * 后者说它现在能不能用（人的开关）。恒报 ready 就是把这两件事压成一件，屏幕于是
   * 说不出「装好了但你关着」。
   */
  function readCapabilities(record: Session): readonly {
    readonly id: string
    readonly pluginId: string | null
    readonly label: string
    readonly supported: boolean
    readonly state: 'notInstalled' | 'partial' | 'ready' | 'unsupported'
    readonly install: {
      readonly running: boolean
      readonly step: string | null
      readonly percent: number | null
      readonly error: string | null
    }
  }[] {
    /*
     * `ready` 说的是「开着」，`notInstalled` 说的是「关着」。
     *
     * 不能拿 `getEvalPreludes()` 当可用性判据：那一支在 `computer.enabled` 为假时
     * **整份交回空表**（sdk.ts:2009-2021 的 `if (settings.get("computer.enabled"))`），
     * 于是「关着」与「这个构建没有」会读成同一件事，界面就说不出「装好了但你关着」。
     *
     * 所以 `supported` 报构建事实：omp 的 `createComputerPrelude` 是静态编进来的
     * （sdk.ts:244 的 import），这块能力在这个构建里恒在；真正的平台可用性要等
     * 真去开它才验得出来（pi-natives 的 DesktopSession），而那一步在
     * `toggleComputerUse` 里按 omp 官方的做法当场验、验不过就回滚。
     */
    const enabled = record.settings.get('computer.enabled') === true

    return [
      {
        id: COMPUTER_USE_ID,
        pluginId: null,
        label: 'Computer use',
        supported: true,
        state: enabled ? 'ready' : 'notInstalled',
        install: { running: false, step: null, percent: null, error: null },
      },
    ]
  }

  /*
   * 打开或关上桌面控制。
   *
   * 走 omp 官方那两步（slash-commands/builtin-modes.ts:122-138 的
   * `applyComputerUseToggle`），一步都不少：
   *
   * 1. `settings.override` 是**会话级**覆盖，刻意不落盘 —— 那是它自己的选择，
   *    盘的写入面在设置页（`computer.enabled` 是普通设置，set_setting 能改）。
   *    官方注释逐字「The override is never persisted to settings.json」。
   * 2. `refreshBaseSystemPrompt()` 让前奏进出系统提示词。只做第一步，模型手上的
   *    工具面要到下一轮才变；官方把这一步放在同一次调用里，正是为了当场生效。
   *
   * 开之前先验前奏在不在：不在就回滚并把话说清楚，而不是留一个「开着的」假象。
   */
  async function toggleComputerUse(record: Session, enabled: boolean): Promise<unknown> {
    const previous = record.settings.get('computer.enabled')

    /*
     * 走它自己的持久层（与 browser.* 那三格同一条路）：这一格是设置页上的开关，
     * 关掉再开一次之后必须还在 —— 会话级 override 一重启就没了。
     *
     * 官方 `/computer` 用 override 是因为它是**会话内**的临时开关（官方注释逐字
     * 「never persisted to settings.json」）；我们这一格是设置页的持久控件，所以
     * 取它的持久写入面，而把官方那一步 `refreshBaseSystemPrompt` 一起做掉。
     */
    record.settings.set('computer.enabled', enabled)

    try {
      await record.settings.flush()
      /*
       * 可用性判据必须在写完**之后**读：前奏是惰性建的，而 `getEvalPreludes()` 只在
       * `computer.enabled` 为真时才去建它（sdk.ts:2009-2021）—— 写之前读恒是空表，
       * 那会把「这块能力能用」一律读成「不能用」。官方 `applyComputerUseToggle` 也是
       * 先落设置再验前奏（slash-commands/builtin-modes.ts:123-128）。
       */
      if (
        enabled &&
        !record.agent.getEvalPreludes().some((prelude) => prelude.name === COMPUTER_PRELUDE)
      ) {
        throw new Error('this session has no computer-use prelude available')
      }

      /*
       * 前奏进出系统提示词要靠这一动：只写设置，模型手上的工具面要到下一轮才变，
       * 而人此刻看到的开关已经是新的了 —— 中间那段不一致正是要消掉的东西。
       */
      await record.agent.refreshBaseSystemPrompt()
    } catch (error) {
      /* 改到一半失败要把设置还原：留着它等于报了一件没发生的事。 */
      record.settings.set('computer.enabled', previous as never)
      await record.settings.flush().catch(() => undefined)
      throw error
    }

    return { capabilities: readCapabilities(record) }
  }

  /* omp 的 eval 前奏名与能力 id 是它自己的词（tools/computer 的 prelude-definition
   * 与产品 capability 页的约定），改这里等于认不出它。 */
  const COMPUTER_PRELUDE = 'computer'
  const COMPUTER_USE_ID = 'computer-use'

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

  /*
   * `sharpshooter.model` 的选项表：**此刻配好的那些模型**，外加「自动」。
   *
   * 这一格在 schema 里只是 string，上游不给选项（它自己的 TUI 用模型浏览器现选），
   * 所以选项必须在这里算。用的是与会话/入口那一格**同一个产地**：`resolveAllowedModels`
   * 读 `enabledModels` 范围与凭据后的注册表 —— 自己写一份「有钥匙的 provider 的模型」
   * 就是第二个事实，两边必然分叉。
   *
   * 取值拼法 `provider/id` 与 aliasOf、与会话入口那一格逐字相同（见 expected-state.ts
   * 的注释）：拼法不同，选完对不上。
   *
   * 「自动」那一档的值是**空串**，不是 null：这一格留空 = 用 smol 角色（上游
   * sharpshooter/extract.ts 的 resolveSharpshooterModel 就是先读这一格、读不到才回退
   * smol）。写回 agent 的也必须是空串 —— 这是它自己的「没配」表示。
   */
  async function settingChoicesOf(settings: Settings): Promise<SettingChoicesOf> {
    const registry = await registryFor()
    const allowed = await resolveAllowedModels(
      registry,
      settings,
      getModelMatchPreferences(settings),
    )
    const choices: readonly SettingOption[] = [
      { value: '', label: '自动（使用 smol 角色）' },
      ...allowed.map((model) => ({ value: aliasOf(model), label: model.name ?? model.id })),
    ]

    /* 目录是同步读的（它是纯映射），所以模型那一份先在这里算完再交出去。 */
    return (path) => (modelSelectorSettingOf(path) ? choices : undefined)
  }

  // 目录与那一格此刻的值都是 agent 自报的（见 settings.ts），我们没有第二份。
  async function settingsCatalog(): Promise<unknown> {
    const settings = await settingsFor()

    return {
      settings: readCatalog(settings, await settingChoicesOf(settings)),
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

    return { settings: readCatalog(settings, await settingChoicesOf(settings)) }
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
   * 产品三颗按钮 → 上游 select 要的一个标签，翻一次再交回去（会话级放行论据正本见
   * resolveApproval）。`scope` 与 `cancelled` 是我们加的两格：「拒绝」与「取消」在上游
   * 都读成 undefined，屏幕上却必须分得清，所以按产品那三颗如实分成两格。
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

  /*
   * 一句话按它点名的层走。`turn` 开一轮（回执带轮身份），另外两层是插话
   * （回执只是「agent 收下了」，队列归它）。
   *
   * 上游还有第四档 `aside`，本仓不接（ADR 0034）。线上形状里已经没有它（wire.rs 的
   * `DeliverAs` 三档），这里守的是**别的写入方**：认不出来的档位必须当场报错，不能落进
   * 下面那条 else —— 那会把一句旁注当成 followUp 排进队列，投出去的层与点名的层不一样。
   */
  function deliverPrompt(
    record: Session,
    command: Extract<BridgeCommand, { type: 'prompt' }>,
  ): Promise<unknown> | unknown {
    if ((command.deliverAs as string) === 'aside') {
      throw new Error('this bridge does not deliver asides')
    }

    return command.deliverAs === 'turn'
      ? sendPrompt(command)
      : deliverInterjection(record, command, command.deliverAs)
  }

  /*
   * 队列那三条命令：读、撤、改模式。三条都落在 agent 自己的读写法上，队列的真相不在
   * 这一侧留副本（Session 里那几格只是「投出去还没露面」的账，用来认领注入消息）。
   */
  function queueCommand(
    record: Session,
    command: Extract<BridgeCommand, { type: 'queue' | 'withdraw' | 'delivery' }>,
  ): unknown {
    if (command.type === 'queue') {
      return { queue: queueOf(record) }
    }

    if (command.type === 'withdraw') {
      const restored = record.agent.popLastQueuedMessage()

      /*
       * 撤回会连带取走紧挨在这句话前面的隐藏伴生消息（上游 `removeWithCompanions`），
       * 所以队列真的变了才推 —— 空队列撤回是一次空转，不改任何东西。
       */
      if (restored !== undefined) {
        emitQueue(record)
      }

      return { message: restored === undefined ? null : { text: restored.text } }
    }

    /* 缺席的格不改；改完按 agent 自己热重载后的那一份报回去。 */
    if (command.steeringMode !== undefined) {
      record.agent.setSteeringMode(command.steeringMode)
    }

    if (command.followUpMode !== undefined) {
      record.agent.setFollowUpMode(command.followUpMode)
    }

    if (command.interruptMode !== undefined) {
      record.agent.setInterruptMode(command.interruptMode)
    }

    const queue = queueOf(record)
    emit({ kind: 'queue', sessionId: record.id, queue })
    return { queue }
  }

  /*
   * 屏幕这一页：开窗在镜像，正文的来源（显示经过）在桥。
   *
   * `warm` 是往回翻到镜像手上还没有的那一段时的现取；`floor` 是显示经过的下界，
   * 页靠它判「还有没有更早的」（镜像手上只有铺过的那些格，判不出这件事）。
   */
  async function readScreen(
    command: Extract<BridgeCommand, { type: 'transcript' }>,
  ): Promise<unknown> {
    const record = await requiredSettled()

    return record.mirror.page(command.agentId, command.beforeTurn ?? undefined, {
      warm: (beforeTurn, stagedFrom) => warmScreen(record, beforeTurn, stagedFrom),
      ...(record.floor === undefined ? {} : { floor: record.floor }),
    })
  }

  async function dispatch(command: BridgeCommand): Promise<unknown> {
    switch (command.type) {
      case 'new_session': {
        /* 号当先交出、期望态当场可读，水合放后台（见 mintSession）。 */
        const id = mintSession(command.cwd)

        return {
          sessionId: id,
          controls: (await readExpectedState(command.cwd)).controls,
        }
      }

      case 'load_session': {
        const record = await loadSession(command.sessionId, command.cwd)

        return record === null
          ? { sessionId: null }
          : { sessionId: record.id, controls: readSelectors(record) }
      }

      case 'prompt':
        return await deliverPrompt(await requiredSettled(), command)

      case 'queue':
      case 'withdraw':
      case 'delivery':
        return queueCommand(await requiredSettled(), command)

      case 'cancel': {
        const record = await requiredSettled()
        await record.agent.abort()
        /*
         * 取消一轮，屏幕上等着人答的那些一起收掉。
         *
         * 上游授权闸门问的那一次 select 不带 signal（wrapper.ts:333），它不会因为这一轮
         * 被取消而自己作罢；谁都不结它，那次工具调用就永远停在 await 上，屏幕上的带子
         * 也永远停在「等你批」。所以这里主动把它们收成取消。
         */
        record.desk.closeAll()
        /*
         * 只在真有轮开着的时候报轮终。
         *
         * 报两次的后果不是崩溃而是账错：abort() 会把在飞的那一轮收掉，那时
         * `prompt()` 的 settle 已经补过一条轮终了，这里再无条件报一条，Rust 侧就对着
         * 同一个会话收两次账（第二次只能记一条日志）。而没有轮开着时（人在「投递结果
         * 未确认」那一刻按停止），这里更不该凭空报一条 cancelled。
         */
        const ended = record.projector.turnEnd('cancelled')

        /*
         * 队列**刻意不排空**：上游 abort 不动 steering 队列（agent-loop.ts:1637-1643），
         * 留给 post-abort 的 continue 消费。所以这里只把队列的新样子推出去，不替用户
         * 删掉任何一句 —— 屏幕上的 chip 在取消之后仍然在，正是它该有的样子。
         */
        forgetInjected(record)
        emitQueue(record)

        if (ended.length === 0) {
          return {}
        }

        pushTranscript(record, ended, true)
        emit({ kind: 'turn_end', sessionId: record.id, outcome: 'cancelled' })
        return {}
      }

      case 'answer_permission':
        return answerPermission(await requiredSettled(), command)

      case 'answer_dialog': {
        const record = await requiredSettled()
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
              /* 产品那一份原样带上：屏幕按题号读答案，上游那份只认标签。 */
              answers: command.response,
            })
      }
      /*
       * 选择器、技能、MCP 三格都是「入口那一屏」的读：会话在手读会话对象（轮次级事实），
       * 还没建好就读期望态（进程级事实）。**刻意不等水合** —— 这三格正是入口要的，
       * 等它就等于把水合的钱付在入口上。分派只转发，判据收在 entryReadOf 一处。
       */
      case 'selectors':
        return { controls: (await entryReadOf()).controls }

      case 'skills':
        return { skills: (await entryReadOf()).skills }

      case 'mcp_servers':
        return { servers: await mcpServersOf() }

      case 'goal':
        return { goal: readGoal(await requiredSettled()) }

      /*
       * 屏幕经过两条读：打开会话要一页基线、断流后要一次追赶，都由镜像答。
       * `beforeTurn` 是客户端翻更早那一页的游标（轮号）：一页装不下时镜像只交最新的
       * 那一截，剩下的靠它再来一趟。
       */
      case 'transcript':
        return readScreen(command)

      case 'transcript_ops':
        return (await requiredSettled()).mirror.catchUp(command.agentId, command.sinceSeq)

      case 'select':
        return await selectControl(command)

      case 'fork_session':
        return await forkSession(await requiredSettled(), command)

      case 'sessions':
        return await listSessions()

      case 'delete_session':
        return await deleteSession(command.sessionId)

      case 'export_session':
        return await exportSession(command.sessionId, command.destination)

      case 'share_session':
        return await shareSessionFor(command.sessionId)

      case 'browser_settings':
        return { browser: browserSettingsOf(await settingsFor()) }

      case 'settings_catalog':
        return await settingsCatalog()

      case 'set_setting':
        return await writeSetting(command.path, command.value)

      case 'set_browser_settings':
        return await writeBrowserSettings(command)

      /*
       * 桌面控制这一项：如实报它此刻开没开。
       *
       * 此前这里恒报 `state: 'ready'`，而 omp 的 `computer.enabled` 默认是 **false**
       * （settings-schema.ts:4375-4384）—— 屏幕因此说「已就绪」，而模型手上根本没有那个
       * 前奏。判据取它自己的两格，一格都不抄：`computer.enabled` 说人开没开，
       * `getEvalPreludes()` 说这条会话里前奏真的装上了没有（omp 自己的 `/computer`
       * 命令正是这么判的，slash-commands/builtin-modes.ts:103-116）。
       *
       * `supported` 取前奏可用性而不是恒 true：这台机器上 omp 没编进 computer
       * 前奏时（比如平台没有 pi-natives 那一块），如实说它不支持。
       */
      case 'capabilities':
        return { capabilities: readCapabilities(await requiredSettled()) }

      /*
       * 打开/关上桌面控制。
       *
       * 命令名沿用「安装」是因为产品那一页叫能力安装（capability-gateway 的
       * installCapability），而 omp 里这一项**没有安装这一步** —— 它是构建期编进来的
       * 前奏，只有开与关。名字留在线上是为了不动已生成的 IPC 契约；语义在这里如实
       * 收成「切换」。
       */
      case 'install_capability': {
        const record = await requiredSettled()

        if (command.capabilityId !== COMPUTER_USE_ID) {
          throw new Error(`this agent has no installable capability called ${command.capabilityId}`)
        }

        return await toggleComputerUse(record, command.enabled)
      }

      case 'model_catalog': {
        const record = await requiredSettled()

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
          record.unsubscribeSubagents?.()
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

  return {
    dispatch,
    agentVersion: VERSION,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
