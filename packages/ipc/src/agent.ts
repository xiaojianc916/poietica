import type {
  AgentCapabilityPort,
  AgentSessionPort,
  OpenedThread,
  QuestionChoice,
  RunEvent,
  SessionConfigChoice,
  SessionConfigControl,
  SessionConfigPort,
  SessionGoal,
  SessionGoalStatus,
  SessionUsagePort,
  ThreadPort,
} from '@poietica/agent-contract'
import { throughIpc } from './error'
import {
  type AgentConfigChoice,
  type AgentConfigControl,
  type AgentGoal,
  type AgentLaunch,
  type AgentMcpServer,
  type AgentQuestionChoice,
  type AgentSessionUsage,
  commands,
} from './generated/ipc-bindings'

/**
 * The desktop implementation of the ports the feature layer declares.
 *
 * It lives here rather than in the feature package because the feature layer
 * declares ports and must stay free of a desktop runtime. The application
 * composes the two.
 *
 * 端口不在这一层重新声明一遍。ThreadPort / SessionConfigPort / AgentCapabilityPort
 * 就是下面几个工厂的返回类型，所以「桥」与「端口」是同一个名字下的同一样东西。
 *
 * Frame shapes are never redefined here: command payloads come from the
 * generated bindings, and frames are handed on exactly as recorded. Their
 * shape is fixed by frame.rs at compile time, so a schema on this side would
 * only add a third description of the protocol to keep in sync.
 */

/** The channel run frames are broadcast on. */
const AGENT_EVENT = 'ai-run-event'

/** 会话自己报来的状态走这一条：选择器表与用量。它不属于任何一轮。 */
const AGENT_SESSION_EVENT = 'ai-session-event'

/**
 * The envelope the native side broadcasts.
 *
 * 信封就是帧：判别式、位置、时刻与载荷平铺在同一层，会话号也在这一层 ——
 * 每一种帧无一例外都自报它（见原生侧 recorder.rs 的 RecordedEvent）。
 *
 * 线上一次带的是一批，不是一个。原生侧按屏幕的节拍攒帧（见 commands/agent/journal.rs），所以跨进程往返的次数不再随 agent 说得多快而涨。一批只属于一条
 * 会话，端口因此原样把整批交出去。
 */
interface AgentEventEnvelope {
  readonly sessionId: string
}

export interface AgentEventSourceOptions {
  /** Reports a transport failure; listening is best-effort by design. */
  readonly onListenFailure?: (error: unknown) => void
}

export interface AgentBridgeOptions {
  /**
   * 这一次起哪个 agent。必填 —— 一个「少了就一定失败」的字段不该长成可选的。
   *
   * 此前这里是 agentId 与 command 两个可选字段，而组合层两处调用只送了后者：
   * 受控 home 因此在运行期一次都没生效过。类型上让它缺不了，比在原生侧兜底
   * 更早发现问题。
   *
   * 哪家 agent、哪个可执行文件、哪几个参数，全由 registry 的档案说了算，这一
   * 层不认识任何一家，也不再把它们拼成一行命令：拼起来再让对面切回去是有损的。
   *
   * 交的是一次求值，不是一个值。桥在启动时就建好，而「用哪一家」要等落盘的配置
   * 读回来才知道，之后还会被设置页改掉：捕获建桥那一刻的答案，等于把第一帧的
   * 猜测钉死一整个进程。
   */
  readonly launch: () => AgentLaunch | Promise<AgentLaunch>
  /**
   * 这一次在哪个工作目录里开会话。
   *
   * 与上面的 launch 同一条规矩，理由也同一个：桥在启动时就建好，而人可以
   * 随时换一个工作目录。捕获建桥那一刻的答案，等于把第一帧的猜测钉死一整个
   * 进程 —— 此前这一格是个值，而组合层连那个值都没有传。
   */
  readonly cwd?: () => string | null
}

/**
 * Subscribes to one native event.
 *
 * Unsubscribing has to be synchronous for the port, while Tauri's listener
 * registration is asynchronous, so a handle that arrives after the caller has
 * already given up is torn down immediately instead of leaking.
 *
 * 两条通道共用它。这段拆解此前只服务于运行帧一条，而第二条通道到来时照抄一遍，
 * 就是第二处要各自修的地方。
 */
function subscribeToEvent<TPayload>(
  event: string,
  handler: (payload: TPayload) => void,
  onListenFailure?: (error: unknown) => void,
): () => void {
  let cancelled = false
  let stop: (() => void) | null = null

  void import('@tauri-apps/api/event')
    .then((module) => module.listen<TPayload>(event, (received) => handler(received.payload)))
    .then((unlisten) => {
      if (cancelled) {
        unlisten()
        return
      }

      stop = unlisten
    })
    .catch((error: unknown) => {
      onListenFailure?.(error)
    })

  return () => {
    cancelled = true
    stop?.()
    stop = null
  }
}

/*
 * 线上那条会话状态推送的形状。
 *
 * 原生侧的 AgentSessionEvent，camelCase 之后就是它。事件不是命令，specta 只认
 * 命令签名，所以它不在生成绑定里 —— 但里面每一格仍取自生成绑定，形状没有第二
 * 个定义。
 */
type AgentSessionEnvelope =
  | {
      readonly kind: 'selectors'
      readonly sessionId: string
      readonly selectors: AgentConfigControl[]
      readonly goal: AgentGoal | null
    }
  | { readonly kind: 'usage'; readonly sessionId: string; readonly usage: AgentSessionUsage }

/**
 * 一条通道，按判别式交给它的读者。
 *
 * 会话状态同走一条事件，与运行帧同走 AGENT_EVENT 是同一条规矩。
 * 分派按判别式静态展开，不是一张可以注册任意名字的表 —— 每一个读者仍是一个具名端口。
 */
function subscribeToSessionEvent<TKind extends AgentSessionEnvelope['kind']>(
  kind: TKind,
  handler: (payload: Extract<AgentSessionEnvelope, { kind: TKind }>) => void,
  onListenFailure?: (error: unknown) => void,
): () => void {
  return subscribeToEvent<AgentSessionEnvelope>(
    AGENT_SESSION_EVENT,
    (payload) => {
      if (payload.kind === kind) {
        handler(payload as Extract<AgentSessionEnvelope, { kind: TKind }>)
      }
    },
    onListenFailure,
  )
}

/*
 * 一题的答复，从端口的形状搬到生成绑定的形状。
 *
 * 只有一件事真的在发生：readonly 的选项数组要复制成可变的。判别式与每一格的名字
 * 两侧逐字相同 —— 它们都取自 kap 的 questionAnswerSchema，所以这里没有翻译表。
 */
function questionChoiceOf(choice: QuestionChoice): AgentQuestionChoice {
  switch (choice.kind) {
    case 'single':
      return { kind: 'single', optionId: choice.optionId }
    case 'multi':
      return { kind: 'multi', optionIds: [...choice.optionIds] }
    case 'other':
      return { kind: 'other', text: choice.text }
    case 'multi_with_other':
      return {
        kind: 'multi_with_other',
        optionIds: [...choice.optionIds],
        otherText: choice.otherText,
      }
    case 'skipped':
      return { kind: 'skipped' }
  }
}

/**
 * 会话这一路：一条订阅收帧，七条命令回话。
 *
 * 收与发同住一个工厂，因为它们是同一个端口的两半：拆成「事件源 + 命令桥」再由组合
 * 层拼回去，拼出来的只是一层透传。取消点名一条对话而不是一轮，理由在端口定义处。
 * 审批的答复词汇由类型定死（kap 的三个 decision 与一个 scope），一组题的合法性由
 * 原生侧对着被问的那一组判。
 */
export function createAgentSessionPort({
  launch,
  cwd,
  onListenFailure,
}: AgentBridgeOptions & AgentEventSourceOptions): AgentSessionPort {
  return {
    /* 帧原样交出去，不在这里再校验一遍：形状由 frame.rs 的 enum 在编译期定下，
    这一侧再写一份运行期 schema 只会多出一个「协议新增字段即整轮判废」的故障模式。 */
    subscribe: (listener) =>
      subscribeToEvent<readonly AgentEventEnvelope[]>(
        AGENT_EVENT,
        (payload) => {
          /* 一拍的帧一起到，也一起交出去：一批只属于一条会话（见 recorder.rs
          的 Frames::new），所以地址从头一帧上取一次就对整批成立。 */
          const first = payload.at(0)

          if (first !== undefined) {
            listener(payload as readonly RunEvent[], first.sessionId)
          }
        },
        onListenFailure,
      ),

    prompt: async (request) => {
      const resolvedLaunch = await launch()
      const started = await throughIpc(() =>
        commands.agentPrompt({
          text: request.text,
          threadId: request.threadId,
          configuration: request.configuration.map((selected) => ({
            id: selected.id,
            value: selected.value,
          })),
          /* readonly 的数组与生成绑定要的可变数组是两个类型，所以复制一次 ——
          数组复制只在这一层做。 */
          skills: request.skills.map((skill) => ({
            name: skill.name,
            args: skill.args ?? null,
          })),
          assets: request.assets.map((asset) => ({
            sessionToken: asset.sessionToken,
            assetToken: asset.assetToken,
          })),
          launch: resolvedLaunch,
          cwd: cwd?.() ?? null,
        }),
      )

      return { sessionId: started.sessionId }
    },

    cancel: async (threadId) => {
      await throughIpc(() => commands.agentCancel({ threadId }))
    },

    steer: async (threadId, promptIds) => {
      /* readonly 数组与生成绑定要的可变数组是两个类型，所以复制一次。 */
      await throughIpc(() => commands.agentSteer({ threadId, promptIds: [...promptIds] }))
    },

    abortPrompt: async (threadId, promptId) => {
      await throughIpc(() => commands.agentAbortPrompt({ threadId, promptId }))
    },

    resolvePermission: async (requestId, decision, scope) => {
      /* 线上「只此一次」是 null，端口那一侧是缺席 —— 转换只在这一层。 */
      await throughIpc(() =>
        commands.agentResolvePermission({ requestId, decision, scope: scope ?? null }),
      )
    },

    answerQuestions: async (response) => {
      await throughIpc(() =>
        commands.agentAnswerQuestions({
          questionId: response.questionId,
          /* 同上：readonly 的数组要复制成可变的。 */
          answers: response.answers.map((answered) => ({
            questionId: answered.questionId,
            answer: questionChoiceOf(answered.answer),
          })),
          method: response.method ?? null,
          note: response.note ?? null,
        }),
      )
    },

    dismissQuestions: async (questionId) => {
      await throughIpc(() => commands.agentDismissQuestions({ questionId }))
    },
  }
}

/** Ends the session and lets the agent process exit. */
export async function shutdownAgent(): Promise<void> {
  await throughIpc(() => commands.agentShutdown())
}

/*
 * 改一项会话设置，一个命令。
 *
 * 没有"读"的那一路：选择器随会话一起回来（见下面的 open），改完之后 agent 又把
 * 整张表报回来。协议定义的东西不在这里重新定义，类别由 agent 说了算。
 */

/*
 * 线上说 null 表示缺席，端口说缺席就是没有这一格 —— 在 exactOptionalPropertyTypes
 * 下这是两个类型，所以这个键要么带值、要么不出现。
 *
 * 这句判断此前在 choiceOf 与 controlOf 里各写一遍。同一条规则写两遍，就会有一天
 * 只改了一遍。
 */
function detailOf(detail: string | null): { detail?: string } {
  return detail === null ? {} : { detail }
}

/*
 * 进来的是线上的类型本身，出去的是端口的类型本身：线上一个定义，端口一个
 * 定义，中间只剩 detail 那一格真正的转换。purpose 不需要任何处理 ——
 * AgentConfigPurpose 与 SessionConfigPurpose 是同一个四值集，原生侧已经把
 * agent 自己发明的类别归进了 other。
 */
function choiceOf(native: AgentConfigChoice): SessionConfigChoice {
  return { value: native.value, label: native.label, ...detailOf(native.detail) }
}

function controlOf(native: AgentConfigControl): SessionConfigControl {
  return {
    id: native.id,
    label: native.label,
    purpose: native.purpose,
    ...(native.appliesOnSubmit ? { appliesOnSubmit: true as const } : {}),
    current: native.current,
    choices: native.choices.map(choiceOf),
    ...detailOf(native.detail),
  }
}

/** 线上目标 -> 契约。到达时刻在这里打戳：它是本机事实，越靠边界越准。 */
function goalOf(reported: AgentGoal | null): SessionGoal | null {
  if (reported === null) {
    return null
  }

  return {
    objective: reported.objective,
    completionCriterion: reported.completionCriterion,
    status: reported.status as SessionGoalStatus,
    turnsUsed: reported.turnsUsed,
    tokensUsed: reported.tokensUsed,
    wallClockMs: reported.wallClockMs,
    receivedAt: performance.now(),
  }
}

export function createAgentSessionConfigBridge({
  onListenFailure,
}: AgentEventSourceOptions = {}): SessionConfigPort {
  return {
    select: async (threadId, configId, value, input) => {
      const offered = await throughIpc(() =>
        commands.agentSetConfigOption({
          threadId,
          configId,
          value,
          input: input ?? null,
        }),
      )

      return offered.map(controlOf)
    },

    /* 线上叫 selectors，端口叫 controls；改名只发生在这一层。 */
    subscribe: (handler) =>
      subscribeToSessionEvent(
        'selectors',
        (payload) => {
          handler({
            sessionId: payload.sessionId,
            controls: payload.selectors.map(controlOf),
            goal: goalOf(payload.goal),
          })
        },
        onListenFailure,
      ),
  }
}

/*
 * 用量这一路。
 *
 * 载荷在原生侧就已经解成了类型（commands/agent/dto.rs 的 reported_usage），所以
 * 这一层没有要校验的东西，形状也没有第二个定义。它不留副本 —— 唯一的消费者是
 * SessionControlsStore，留第二份就是留第二个事实来源。
 */

export function createAgentSessionUsageBridge({
  onListenFailure,
}: AgentEventSourceOptions = {}): SessionUsagePort {
  return {
    subscribe: (handler) =>
      subscribeToSessionEvent(
        'usage',
        (payload) => {
          handler({ sessionId: payload.sessionId, usage: payload.usage })
        },
        onListenFailure,
      ),
  }
}

/*
 * 问这个 agent 提供什么、改其中一项、听它自己改主意，都不点名任何一条对话。
 *
 * 两个动作走同一条会话：连接自带的锚会话。不新开会话、不写库、不碰任何 thread。
 * 模型、模式、推理档位同表来同表走 —— 改一项之后整张表重读一次（crates/
 * agent-runtime/src/driver.rs 的 set_selector：写完 profile 重跑一次
 * get_selectors，status、/models 与 goal 一并重问），因为改一项可能增删另一项，
 * 所以这一层不拆表也不合表。
 *
 * select 传 threadId: null，原生侧据此发往锚会话；带对话名的那条路是
 * SessionConfigPort。两者是同一个命令的两个地址，不是两套实现。
 *
 * 形状不在这里重新定义：请求体来自生成绑定，答复复用 controlOf，返回的就是
 * 组合层要的那个端口。
 */
export function createAgentCapabilityBridge({
  cwd,
  launch,
  onListenFailure,
}: AgentBridgeOptions & AgentEventSourceOptions): AgentCapabilityPort {
  return {
    read: async () => {
      const resolvedLaunch = await launch()
      const offered = await throughIpc(() =>
        commands.agentCapabilities({
          launch: resolvedLaunch,
          cwd: cwd?.() ?? null,
        }),
      )

      return offered.map(controlOf)
    },

    select: async (control, value) => {
      const offered = await throughIpc(() =>
        commands.agentSetConfigOption({
          threadId: null,
          configId: control.id,
          value,
          input: null,
        }),
      )

      return offered.map(controlOf)
    },

    /* 报文里那条会话是谁，锚会话这一侧回答不了，所以只把「变了」交出去。 */
    subscribe: (handler) =>
      subscribeToSessionEvent(
        'selectors',
        () => {
          handler()
        },
        onListenFailure,
      ),

    readToolkit: createAgentToolkitReader(cwd === undefined ? { launch } : { launch, cwd }),
  }
}

/*
 * Conversations, reached through two ordinary commands.
 *
 * A conversation and an agent session are opened together, so no
 * identifier is invented here: both come back from the native side, and a
 * tab therefore always stands for something the agent knows about.
 *
 * 一条对话长什么样、它的经过为什么是现在这个样子，两个形状都由端口定义
 * （ThreadRecord 与 ThreadHistory）。生成绑定的 AgentThread 与 AgentHistory
 * 逐格与它们相同，所以这里原样交出去，不复制、不改名、也不再抄一份说明。
 */
export function createAgentThreadBridge({ launch, cwd }: AgentBridgeOptions): ThreadPort {
  const openTarget = async (
    target: { readonly kind: 'create' | 'existing'; readonly threadId: string },
    workspaceRoot?: string | null,
  ): Promise<OpenedThread> => {
    const resolvedLaunch = await launch()
    const opened = await throughIpc(() =>
      commands.agentOpenThread({
        target,
        launch: resolvedLaunch,
        cwd: workspaceRoot ?? cwd?.() ?? null,
      }),
    )

    return {
      thread: opened.thread,
      selectors: opened.selectors.map(controlOf),
      goal: goalOf(opened.goal),
      frames: opened.frames,
      history: opened.history,
      ...(opened.usage === null ? {} : { usage: opened.usage }),
    }
  }

  return {
    list: () => throughIpc(() => commands.agentThreads()),
    create: (threadId, workspaceRoot) => openTarget({ kind: 'create', threadId }, workspaceRoot),
    open: (threadId) => openTarget({ kind: 'existing', threadId }),
    earlierFrames: (threadId, before) =>
      throughIpc(() => commands.agentEarlierFrames({ threadId, before })),
    rename: async (threadId, title) => {
      await throughIpc(() => commands.agentRenameThread({ threadId, title }))
    },
    fork: async (threadId, title, dropTurns) => {
      const resolvedLaunch = await launch()
      return throughIpc(() =>
        commands.agentForkThread({
          threadId,
          title,
          dropTurns,
          launch: resolvedLaunch,
          cwd: cwd?.() ?? null,
        }),
      )
    },
    remove: async (threadId) => {
      await throughIpc(() => commands.agentDeleteThread({ threadId }))
    },
    archive: async (threadId, archived) => {
      await throughIpc(() => commands.agentArchiveThread({ threadId, archived }))
    },
    setPinned: async (threadId, pinned) => {
      await throughIpc(() => commands.agentPinThread({ threadId, pinned }))
    },
  }
}

/*
 * 名册这一路：技能与 MCP 一次问回，发往点名的那条对话自己的会话。
 *
 * 交出去的是能力端口上那一格读法本身，不是第二个端口对象 —— 组合层把它装进
 * AgentCapabilityPort，名册与可调项因此同 scope、同一台 store。
 *
 * 这一侧不留副本；线上说 null 表示缺席，端口那一侧是没有这一格。
 */
export function createAgentToolkitReader({
  launch,
  cwd,
}: AgentBridgeOptions): AgentCapabilityPort['readToolkit'] {
  return async (threadId) => {
    const listed = await throughIpc(async () =>
      commands.agentToolkit({ launch: await launch(), cwd: cwd?.() ?? null, threadId }),
    )

    return {
      skills: listed.skills,
      mcpServers: listed.mcpServers.map((server: AgentMcpServer) => ({
        id: server.id,
        name: server.name,
        status: server.status,
        toolCount: server.toolCount,
        ...(server.lastError === null ? {} : { lastError: server.lastError }),
      })),
    }
  }
}
