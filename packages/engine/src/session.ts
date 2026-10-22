import type { Disposable } from '@poietica/foundation'
import type { TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import type {
  CommandOutputTone,
  ContextUsage,
  Controls,
  DeliverAs,
  Interaction,
  InteractionAnswer,
  ModelRef,
  Posture,
  QueueSnapshot,
  SessionState,
  SideTopic,
  SlashCommand,
  UsageSample,
} from './values'

export interface OpenSessionSpec {
  readonly key: string // 调用方的稳定标识（conversation 用 threadId），用于日志和工具上下文
  readonly cwd: string
  readonly sessionFile: string | null // null = 新建会话
  readonly posture: Posture
  readonly model: ModelRef | null
  readonly thinking: string | null
  readonly autoTitle?: boolean
}

/**
 * 随这一句交给模型、但**不画进气泡**的上下文（例如对话内智能界面的最新状态）。
 *
 * 由别的功能经 conversation 的轮次上下文登记处交来；引擎把它附在投递正文的末尾，重开会话时再摘掉 ——
 * 气泡、标题、用量口径只认 `text`。`text` 是给模型看的原文，引擎负责让它拆不开外层的标记。
 */
export interface TurnContextBlock {
  /** 来源功能 id（例如 `intelligent-ui`）：模型据此知道这段话从哪来；只许小写字母、数字与连字符 */
  readonly source: string
  readonly text: string
}

export interface SubmitInput {
  readonly text: string
  readonly images: readonly { readonly path: string; readonly mime: string }[]
  readonly files: readonly { readonly path: string; readonly name: string }[]
  readonly skills: readonly string[]
  readonly deliverAs: DeliverAs
  /**
   * 调用方给这一句起的号（conversation 填 clientTurnId）。引擎不解释它，只在这一句**作为排队项**有了结局时
   * 经 `queueSettled` 原样交回 —— 队列快照的项号是引擎自己签的，调用方没有别的办法把结局对回自己的记录（审查 R-20-1）。
   */
  readonly ref?: string | undefined
  /** 见 `TurnContextBlock`。缺省 = 这一句没有附带上下文 */
  readonly context?: readonly TurnContextBlock[] | undefined
}

/**
 * 一条排队项（steer / followUp）的结局：
 * - `delivered`：agent 已经把它从队列里取走（进了上下文），之后是会话文件里的事实；
 * - `withdrawn`：人撤回了它（换层 `moveQueued` 不算撤回，号跟着原始输入走）；
 * - `dropped`：agent 丢弃了它（omp 的 promptDropped），这句话没有进上下文。
 */
export type QueueOutcome = 'delivered' | 'withdrawn' | 'dropped'

export type EngineSessionEvent =
  | { readonly type: 'timeline'; readonly agentId: string; readonly ops: readonly TranscriptOperation[] }
  | { readonly type: 'timelineReset'; readonly agentId: string } // 压缩（compaction）等导致必须整页重取
  | {
      readonly type: 'state'
      readonly state: SessionState
      readonly error: { readonly code: string; readonly message: string } | null
    }
  | { readonly type: 'interactionRequested'; readonly interaction: Interaction }
  | { readonly type: 'interactionResolved'; readonly interactionId: string }
  | { readonly type: 'queue'; readonly queue: QueueSnapshot }
  | { readonly type: 'controls'; readonly controls: Controls }
  /*
   * 上下文用量**单独一条通道**，不搭 controls 那班车：controls 是「控件变化」（模型 / 档位 / 姿态 / 模式），
   * 而用量是每轮都在涨的读数 —— 搭同一班车意味着跑完一轮不重画，或者每轮重发一次整张控件表。
   *
   * 报 null 也是**一次有效报数**：「这条会话现在没有可报的窗口」与「还没报过」对屏幕是两件事 ——
   * 前者要收掉已经画出来的圆环（换了没有窗口元数据的模型），后者是首帧。所以这一支收 nullable，
   * 而 controls.context 那一格仍然只是初值。
   */
  | { readonly type: 'contextUsage'; readonly usage: ContextUsage | null }
  | { readonly type: 'usage'; readonly usage: UsageSample }
  | { readonly type: 'promptDropped'; readonly text: string } // omp 丢弃了一条用户输入，必须告诉用户
  /* 带 `ref` 交进来的排队项有了结局（审查 R-20-1）；没带 `ref` 的不报。同一个 ref 可能报不止一次，接收方按幂等处理。 */
  | { readonly type: 'queueSettled'; readonly ref: string; readonly outcome: QueueOutcome }
  /*
   * omp 的会话名变了（omp 是会话名的唯一产地，P4）：`source` 照 omp 的 titleSource —— `auto` = 自动总结（替换 Core 的首句兜底），
   * `user` = 用户定名（GUI 改名、`/rename` 命令、分叉命名都经 omp 写入后从这里回来）。
   * 带 sessionFile 让 Core 认出「这是哪条会话的名」——线程释放重开后，迟到的事件不许改现在的标题。
   */
  | {
      readonly type: 'sessionTitle'
      readonly title: string
      readonly source: 'auto' | 'user'
      readonly sessionFile: string
    }
  /* 命令表变了（装卸插件、技能 / 自定义命令目录变化、MCP 提示词上线）：调用方重读 `commands()`，事件本身不带表 */
  | { readonly type: 'commandsChanged' }
  /*
   * 斜杠命令给人的输出（omp 的 runtime.output）。**不进会话文件**，所以不走时间线：屏幕把它画成一条横幅。
   * `tone` 由认得原句的适配器定（它才知道「Fast mode is unavailable」是失败不是成功）：屏幕据此挑横幅的色调，
   * 不再拿中文去猜成败。
   */
  | { readonly type: 'commandOutput'; readonly text: string; readonly tone: CommandOutputTone }
  /*
   * 侧边提问（`askSide`）的三条事件。它们**不碰时间线、不改 state**：侧边一问不进主会话文件，主对话的屏幕与停止键都与它无关。
   * - `sideTopic`：话题的整份快照，每次生命周期变化各发一次（开问、答完、停止、出错）—— 接收方按它整份替换；
   * - `sideDelta`：正在答的那一问又流出一截。`turn` 是这一问在话题里的下标，`offset` 是这一截之前已有的字数（UTF-16 码元）——
   *   接收方手里的长度对不上 offset 就说明漏了一截，该重读 `sideTopics()`，而不是硬拼（与时间线的 seq 同一条规矩）；
   * - `sideNotice`：话题没能存盘之类的提醒（答案还在内存里，但重开会话后会丢）。
   */
  | { readonly type: 'sideTopic'; readonly topic: SideTopic }
  | {
      readonly type: 'sideDelta'
      readonly topicId: string
      readonly turn: number
      readonly offset: number
      readonly delta: string
    }
  | { readonly type: 'sideNotice'; readonly message: string }

export interface EngineSession {
  readonly sessionId: string
  readonly sessionFile: string
  state(): SessionState
  /**
   * 会话里还有东西在跑：主轮 running、有待答交互，**或者一个侧边提问还在答**。会话池据此不回收它 ——
   * 回收会把侧边那一问当场停掉。只想知道主对话忙不忙（删除 / 分叉的守卫、停止键）的调用方读 `state()`。
   */
  isBusy(): boolean
  subscribe(listener: (event: EngineSessionEvent) => void): Disposable
  submit(input: SubmitInput): Promise<void> // turn：开始一轮后立即返回；steer / followUp：入队后返回
  cancel(): Promise<void>
  queue(): QueueSnapshot
  /**
   * 撤回一条还排着的输入。该项已经被 agent 消费时抛 `engine.queue_item_consumed`；不存在时抛 `kernel.not_found`。
   */
  withdraw(queueItemId: string): void
  /**
   * 把一条排队项换到另一层（steer ⇄ followUp）：用该项的原始输入重新入队（图片、文件、技能都保留），
   * 排在目标层队尾并拿到新 id；已被 agent 消费时抛 `engine.queue_item_consumed`，目标层与当前层相同则什么都不做。
   */
  moveQueued(queueItemId: string, deliverAs: 'steer' | 'followUp'): Promise<void>
  setQueueModes(modes: Partial<QueueSnapshot['modes']>): void
  controls(): Controls
  setModel(model: ModelRef): Promise<void>
  setThinking(level: string): void
  setPosture(posture: Posture): void
  setPlanMode(enabled: boolean): Promise<void>
  /**
   * 设置 / 清除目标（null = 清除）。设置**只改正文、不改状态**（R-10）：没有目标（或上一个已完成）就新建一个进行中的目标；
   * 已有目标且正文不同就换成新正文（omp 的 replace：用量从零记），进行中的仍进行中、已暂停的仍暂停；正文相同什么都不做。
   */
  setGoal(goal: string | null): Promise<void>
  /**
   * 暂停目标：本轮照常跑完（不打断），之后不再计用量、不再注入目标上下文（R-10）。
   * 已暂停时什么都不做；没有进行中（或受阻）的目标时抛 `kernel.not_found`。
   */
  pauseGoal(): Promise<void>
  /**
   * 继续已暂停的目标（R-10）。已在进行中时什么都不做；没有已暂停的目标时抛 `kernel.not_found`；
   * 目标模式在 agent 设置里关掉时抛 `engine.goal_unavailable`。
   */
  resumeGoal(): Promise<void>
  /**
   * 用户给会话定名（omp 的 setSessionName(name, 'user')，与 omp RPC `set_session_name` 同一条路）：写进会话文件，
   * 之后 omp 不再自动起名；结果经 `sessionTitle`（source: user）报回。空名报 invalid_params。忙时也可改。
   */
  rename(title: string): Promise<void>
  /** 此刻可用的斜杠命令（omp 现算；GUI 宿主办不了的几条已剔除） */
  commands(): Promise<readonly SlashCommand[]>
  /**
   * 执行一句以 `/` 开头的输入，路由与 omp 自己的宿主（RPC / ACP）同一个次序：内置命令 → 其余交给 `prompt()`
   * （扩展命令、自定义命令、文件命令由 omp 在 prompt 里就地处理）。与 `submit` 一样**开始后立即返回**：
   * 状态切 running（停止键可用），给人的文字走 `commandOutput`，收口时补一条 `timelineReset` —— 命令改的是
   * 会话文件里的事实，屏幕从文件重取，不在增量里猜它改了什么。非 idle 抛 `engine.busy`；不认识的命令抛
   * `engine.command_unknown`（不会被当成普通一句话发给模型）。
   */
  runCommand(text: string): Promise<void>
  interactions(): readonly Interaction[]
  respond(interactionId: string, answer: InteractionAnswer): void
  /**
   * 时间线的一页。`agentId` = 通道号：`'main'` 是主对话，其余是这条会话派出去的子代理（号与 task 行的
   * `agentId`、工具帧的 `agentRefs` 同一个值）。子代理的通道与主对话同一套 ops 形状，增量经 `timeline`
   * 事件按同一个 agentId 推出；认不出的号交一页空表（它可能是重开前的旧子代理，屏幕照样画得出空面板），不抛。
   */
  page(agentId: string, beforeTurnId: string | null): Promise<TranscriptPage>
  /**
   * 停掉一个子代理（与 omp RPC `cancel_subagent` 同一条路：先立墓碑、再 abort 它自己的会话），父轮照常往下走 ——
   * 父轮收到的是「这个子代理被停了」的结果。返回 false = 它此刻不在运行（已结束、已被收下结果、不认识）；不抛。
   */
  cancelSubagent(agentId: string): Promise<boolean>
  /**
   * 以用户身份给一个运行中的子代理插一句话（omp RPC `steer_subagent`，即 Agent Hub 聊天同一条路）：
   * 跑着的在下一个步边界收到，闲着的开它的下一轮；这句话记进子代理自己的会话，不记到父会话。
   * 被收下（入队或开轮）即返回；不在运行时抛 `engine.subagent_not_running`，空文本抛 invalid_params。
   */
  steerSubagent(agentId: string, text: string): Promise<void>
  /**
   * 停掉一个后台作业（task 行 `kind` 为 shell / tool 的那些，号是 task 行的 `taskId`）。
   * 返回 false = 它已经结束或不认识；不抛。子代理不走这里（用 `cancelSubagent`）。
   */
  cancelBackgroundTask(taskId: string): Promise<boolean>
  /**
   * 侧边提问（omp 的 `/btw`）：拿主对话此刻的上下文（含正在流式输出的那一截）问一句，**不进主会话文件、不改主对话状态**，
   * 主轮跑着也能问。沿用会话的模型与系统提示，与主轮共用提示缓存；**从不执行工具**（omp 的一次性回合不跑工具调用）。
   *
   * `topicId` 为 null 开新话题，否则接在那个话题后面追问。话题落盘、开问之后即返回（返回的快照里这一问是 running），
   * 答案经 `sideDelta` 流出、经 `sideTopic` 收口。同一时刻只答一问：还有一问在答时抛 `engine.side_busy`；
   * 话题不存在抛 `engine.side_topic_unknown`；会话没有可用模型抛 `engine.side_unavailable`；空问题抛 invalid_params。
   */
  askSide(question: string, topicId: string | null): Promise<SideTopic>
  /**
   * 停掉正在答（或正在开问）的那一问；给了 `topicId` 时只停那个话题的。返回 false = 没有对得上的在答，不抛。
   * 已经流出来的那一截留在话题里，状态记 cancelled。
   */
  cancelSide(topicId: string | null): boolean
  /** 这条会话的全部侧边话题，新开的在前；正在答的那一问带着已经流出来的那一截 */
  sideTopics(): Promise<readonly SideTopic[]>
  dispose(): Promise<void>
}
