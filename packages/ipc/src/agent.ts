import type {
  AgentCapabilityPort,
  AgentPalettePort,
  PaletteEntry,
  SessionConfigChoice,
  SessionConfigControl,
  SessionConfigPort,
  ThreadPort,
} from '@poietica/agent-contract'
import { paletteFrom } from '@poietica/agent-contract'
import type { AgentCommandBridge, AgentEventSource } from './acp-session'
import { throughIpc } from './error'
import {
  type AgentConfigChoice,
  type AgentConfigControl,
  commands,
  type JsonValue,
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
 * 此前这里另立了一整套 *Description 与 *Bridge：字段与端口逐格相同，组合层因此
 * 编译得过 —— 靠的是两份手写接口今天恰好一样，而不是同一个定义。同一个形状有了
 * 第二个名字，注释立刻就分叉了：那份 AgentThreadDescription 说 titleSource 有
 * official 一档，而 ThreadTitleSource 与生成绑定的 AgentTitleSource 都只有三档,
 * 后者的文档还专门写着 official 是被删掉的那一档。抄本没有承担任何转换，它只是
 * 一份会过期的说明。
 *
 * Frame shapes are never redefined here. Command payloads come from the
 * generated bindings, and the frames themselves are handed onwards as unknown
 * because the feature package validates every one of them before use.
 */

/** The channel run frames are broadcast on. */
export const AGENT_EVENT = 'ai-run-event'

/** 会话自己报来的选择器表走这一条。它不属于任何一轮，所以不与运行帧同流。 */
export const AGENT_SELECTOR_EVENT = 'ai-selector-report'

/** 会话自己报来的命令表走这一条。它同样不属于任何一轮。 */
export const AGENT_COMMAND_EVENT = 'ai-command-report'

/**
 * The envelope the native side broadcasts.
 *
 * 信封就是帧：判别式、位置、时刻与载荷平铺在同一层，会话号也在这一层 ——
 * 六种帧无一例外都自报它（见原生侧 recorder.rs 的 RecordedEvent）。
 *
 * 线上一次带的是一批，不是一个。原生侧按屏幕的节拍攒帧（见 commands/agent/turn.rs
 * 的 batched），所以跨进程往返的次数不再随 agent 说得多快而涨。一批只属于一条
 * 会话，端口因此原样把整批交出去。
 */
interface AgentEventEnvelope {
  readonly sessionId: string
}

export interface AgentEventSourceOptions {
  /** Reports a transport failure; listening is best-effort by design. */
  readonly onListenFailure?: (error: unknown) => void
}

/** 起一个 agent 进程要说清的三件事。与原生侧的 AgentLaunch 同形。 */
export interface AgentLaunchDescription {
  /** 要启动的 agent。原生侧靠它决定受控 home 落在哪里。 */
  readonly agentId: string
  /** 可执行文件名或路径，不含参数。 */
  readonly program: string
  /** 传给它的参数，原样递给进程。 */
  readonly args: readonly string[]
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
  readonly launch: () => AgentLaunchDescription | Promise<AgentLaunchDescription>
  /**
   * 这一次在哪个工作目录里开会话。
   *
   * 与上面的 launch 同一条规矩，理由也同一个：桥在启动时就建好，而人可以
   * 随时换一个工作目录。捕获建桥那一刻的答案，等于把第一帧的猜测钉死一整个
   * 进程 —— 此前这一格是个值，而组合层连那个值都没有传。
   */
  readonly cwd?: () => string | null
  /**
   * 这一次开会话时要挂哪几台 MCP 服务器。
   *
   * 载荷是 ACP 自己的线上形状，这一层一格都不认识 —— 它只负责把它送过去。协议
   * 的三个结构体在 Rust 那侧全是 #[non_exhaustive]，构造不出来，只能反序列化，
   * 所以线上形状就是契约（原生侧 driver.rs 为图片块立的是同一条规矩）。
   *
   * 与 launch 和 cwd 同一条规矩：交的是一次求值，不是一个值。插件随时会被装上
   * 或拨掉，而桥在启动时就建好了。
   */
  readonly mcpServers?: () => readonly JsonValue[]
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

/** Subscribes to run frames. */
export function createAgentEventSource({
  onListenFailure,
}: AgentEventSourceOptions = {}): AgentEventSource {
  return {
    listen: (handler) =>
      subscribeToEvent<readonly AgentEventEnvelope[]>(
        AGENT_EVENT,
        (payload) => {
          /* 一拍的帧一起到，也一起交出去：一批只属于一条会话（见 recorder.rs
          的 Frames::new），所以地址从头一帧上取一次就对整批成立。 */
          const first = payload.at(0)

          if (first === undefined) {
            return
          }

          handler(payload, first.sessionId)
        },
        onListenFailure,
      ),
  }
}

/*
 * 线上的形状。
 *
 * readonly string[] 与生成绑定要的 string[] 是不同的类型，所以数组在这里复制
 * 一次。字段改名也只发生在这里：它是唯一认识线上写法的一层。
 */
function nativeLaunch(launch: AgentLaunchDescription): {
  agentId: string
  program: string
  args: string[]
} {
  return { agentId: launch.agentId, program: launch.program, args: [...launch.args] }
}

/**
 * The command half of the port.
 *
 * Cancellation names the conversation it stops. 地址要区分的从来不是同一条
 * 会话上的两轮，而是同一条连接上的两条会话：在 A 里按停止，不该停掉此刻在飞
 * 的 B。这一层因此点名对话，原生侧按它查出握着哪条会话 —— 那条对应关系在打开
 * 对话时就写下了，此前那个轮次号是为同一件事另造的第二个地址。
 *
 * Answering a permission request is checked natively: an answer naming an
 * option the agent never offered is refused rather than acted on.
 */
export function createAgentCommandBridge({
  launch,
  cwd,
  mcpServers,
}: AgentBridgeOptions): AgentCommandBridge {
  return {
    prompt: async (request) => {
      const resolvedLaunch = await launch()
      const result = await throughIpc(() =>
        commands.agentPrompt({
          text: request.text,
          threadId: request.threadId,
          /* readonly 的数组与生成绑定要的可变数组是两个类型，所以复制一次 —— 与
          上面 nativeLaunch 同一个理由，也只在这一层做。 */
          assets: request.assets.map((asset) => ({
            sessionToken: asset.sessionToken,
            assetToken: asset.assetToken,
          })),
          launch: nativeLaunch(resolvedLaunch),
          cwd: cwd?.() ?? null,
          mcpServers: [...(mcpServers?.() ?? [])],
        }),
      )

      /* 两格都原样交出去：形状由原生侧定义，与端口逐格相同。 */
      return { sessionId: result.sessionId, images: result.images }
    },

    cancel: async (threadId) => {
      await throughIpc(() => commands.agentCancel({ threadId }))
    },

    resolvePermission: async (requestId, optionId) => {
      await throughIpc(() => commands.agentResolvePermission({ requestId, optionId }))
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
 * 线上那条推送的形状。
 *
 * 原生侧的 AgentSelectorReport，camelCase 之后就是它。事件不是命令，specta 只
 * 认命令签名，所以它不在生成绑定里 —— 但里面那一格仍然取自生成绑定的
 * AgentConfigControl，形状没有第二个定义（这个文件开头就是这么说的）。
 */
interface AgentSelectorEnvelope {
  readonly sessionId: string
  readonly selectors: AgentConfigControl[]
}

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
 * 进来的是线上的类型本身，出去的是端口的类型本身。
 *
 * 这里曾经手抄着 NativeChoice 与 NativeControl，而这个文件开头写着 "Frame shapes
 * are never redefined here"。抄本还抄漏了一格：purpose 被写成 string，于是需要一个
 * purposeOf 把它再窄回四选一 —— 那段小写化防的是协议产生不了的值，那段 other 兜底
 * 则是把原生侧已经做过的决定又做了一遍。
 *
 * 出参此前也是抄本（AgentConfigControlDescription），与 SessionConfigControl 逐格
 * 相同。今天两头都只有一个定义：线上一个，端口一个，中间只剩 detail 那一格真正的
 * 转换。purpose 不需要任何处理 —— AgentConfigPurpose 与 SessionConfigPurpose 是同
 * 一个四值集，原生侧已经把 agent 自己发明的类别归进了 other。
 */
function choiceOf(native: AgentConfigChoice): SessionConfigChoice {
  return { value: native.value, label: native.label, ...detailOf(native.detail) }
}

function controlOf(native: AgentConfigControl): SessionConfigControl {
  return {
    id: native.id,
    label: native.label,
    purpose: native.purpose,
    current: native.current,
    choices: native.choices.map(choiceOf),
    ...detailOf(native.detail),
  }
}

export function createAgentSessionConfigBridge({
  onListenFailure,
}: AgentEventSourceOptions = {}): SessionConfigPort {
  return {
    select: async (threadId, configId, value) => {
      const offered = await throughIpc(() =>
        commands.agentSetConfigOption({ threadId, configId, value }),
      )

      return offered.map(controlOf)
    },

    /* 线上叫 selectors，端口叫 controls；改名只发生在这一层。 */
    subscribe: (handler) =>
      subscribeToEvent<AgentSelectorEnvelope>(
        AGENT_SELECTOR_EVENT,
        (payload) => {
          handler({ sessionId: payload.sessionId, controls: payload.selectors.map(controlOf) })
        },
        onListenFailure,
      ),
  }
}

/*
 * 问这个 agent 提供什么、改其中一项、听它自己改主意，都不点名任何一条对话。
 *
 * 两个动作走同一条会话：连接自带的锚会话。不新开会话、不写库、不碰任何 thread。
 * 模型、模式、推理档位同表来同表走 —— ACP 的 session/new 与 set_config 都回整张
 * 表，因为改一项可能增删另一项，所以这一层不拆表也不合表。
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
          launch: nativeLaunch(resolvedLaunch),
          cwd: cwd?.() ?? null,
        }),
      )

      return offered.map(controlOf)
    },

    select: async (control, value) => {
      const offered = await throughIpc(() =>
        commands.agentSetConfigOption({ threadId: null, configId: control.id, value }),
      )

      return offered.map(controlOf)
    },

    /* 报文里那条会话是谁，锚会话这一侧回答不了，所以只把「变了」交出去。 */
    subscribe: (handler) =>
      subscribeToEvent<AgentSelectorEnvelope>(
        AGENT_SELECTOR_EVENT,
        () => {
          handler()
        },
        onListenFailure,
      ),
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
export function createAgentThreadBridge({
  launch,
  cwd,
  mcpServers,
}: AgentBridgeOptions): ThreadPort {
  return {
    list: () => throughIpc(() => commands.agentThreads()),

    open: async (threadId, workspaceRoot) => {
      const resolvedLaunch = await launch()
      const opened = await throughIpc(() =>
        commands.agentOpenThread({
          threadId: threadId ?? null,
          launch: nativeLaunch(resolvedLaunch),
          cwd: workspaceRoot ?? cwd?.() ?? null,
          mcpServers: [...(mcpServers?.() ?? [])],
        }),
      )

      return {
        thread: opened.thread,
        selectors: opened.selectors.map(controlOf),
        events: opened.events,
        history: opened.history,
        /* 这条对话存下过的图片，以及它一共问过多少次。两格都原样交出去：
        形状由原生侧定义，与端口逐格相同，这一层没有要转换的东西。轮次计数
        是对齐用的尺子 —— 账本里的 turn 从某次迁移之后才开始记，所以认领方
        要从末尾往回数，而末尾在哪只有这个计数说得准。 */
        attachments: opened.attachments,
        spans: opened.spans,
        prompts: opened.prompts,
      }
    },

    rename: async (threadId, title) => {
      await throughIpc(() => commands.agentRenameThread({ threadId, title }))
    },

    remove: async (threadId) => {
      await throughIpc(() => commands.agentDeleteThread({ threadId }))
    },

    archive: async (threadId, archived) => {
      await throughIpc(() =>
        commands.agentArchiveThread({
          threadId,
          archived,
        }),
      )
    },

    setPinned: async (threadId, pinned) => {
      await throughIpc(() => commands.agentPinThread({ threadId, pinned }))
    },
  }
}

/*
 * 命令表这一路。
 *
 * 它自己留一份，因为表是 agent 主动推的：没有任何命令可以顺路把它问回来，而界面
 * 打开插件页时那张表早就报过了。这一份不是缓存 —— 它就是那条推送在这一侧的落点，
 * 唯一的一处。
 *
 * 到达即整表替换。协议规定载荷恒为整表，所以这里没有合并逻辑，也就没有一份会与
 * agent 分叉的累积状态。
 *
 * 通道按订阅者引用计数：第一个订阅者来时接上，最后一个走时收掉。没有人看的时候
 * 不必留着一个监听器，而这一层也不该有一个只能装不能卸的全局副作用。
 */
export function createAgentPaletteBridge({
  onListenFailure,
}: AgentEventSourceOptions = {}): AgentPalettePort {
  let entries: readonly PaletteEntry[] = []
  let stop: (() => void) | null = null

  const listeners = new Set<() => void>()

  const listen = (): (() => void) =>
    subscribeToEvent<unknown>(
      AGENT_COMMAND_EVENT,
      (payload) => {
        const reported = paletteFrom(payload)

        /* 不是一张命令表就不动已经收到的那一份。 */
        if (reported === undefined) {
          return
        }

        entries = reported

        for (const listener of listeners) {
          listener()
        }
      },
      onListenFailure,
    )

  return {
    read: () => entries,

    subscribe: (listener) => {
      listeners.add(listener)
      stop ??= listen()

      return () => {
        listeners.delete(listener)

        if (listeners.size > 0) {
          return
        }

        stop?.()
        stop = null
      }
    },
  }
}
