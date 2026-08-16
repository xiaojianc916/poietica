import { throughIpc } from './error'
import {
  type AgentCliResult,
  type AgentConfigSnapshot,
  type AgentInstallStatus,
  commands,
  type JsonValue,
  type AgentCliRequest as NativeAgentCliRequest,
  type ProviderProbeOutcome,
} from './generated/ipc-bindings'

/*
 * 同一个 agent 的配置调用排成一列。
 *
 * agent 的 config.toml 没有跨进程锁，而写它的动作有四个：保存密钥、删除密钥、一次性
 * 导入、改默认模型。前三个都是起一个 agent CLI 子进程做「读整份 → 合并 → 写回」，
 * 一次要好几秒。两个并发跑起来，后写的那个从写前状态出发 —— 上游在自己的测试里写下
 * 过这句话：a write that starts from the pre-edit state would silently drop them.
 *
 * 用户真会这么干：三张厂商卡的忙碌状态各是各的，填完一家的密钥点保存，不等它转完接着
 * 填下一家，是配置 agent 时最自然的动作。两张卡都会说「已写入」，而其中一家的密钥不在
 * 文件里，直到用那家模型时被要求登录。
 *
 * 排队放在这里，而不是把按钮灰掉：用户想做的两件事都合理，只是不该同时写。为此把一个
 * 「谁在写」的状态从页面穿到每张卡再穿到对话页，是让用户替我们的实现细节让路。
 *
 * 读也排在写后面：一次 provider list 若在写到一半时发出，读回的是写前的配置，还会被
 * 存成展示缓存。排队顺带消掉了这条。纯读的那两条命令（密钥尾号、默认模型）不排 ——
 * 原生侧写入是先写临时文件再 rename，读者永远看不到半份文件。
 *
 * 这不是文件锁，拦不住用户手改或 agent 自己写。今天所有写入都出自这一个渲染进程，
 * 所以这条链就是完整的；那个文件本来也没有更强的东西可用。
 */
const queues = new Map<string, Promise<unknown>>()

function inOrder<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  const tail = queues.get(agentId) ?? Promise.resolve()
  const next = tail.then(work)

  /* 队尾永远不带失败：一次写入出错，不该把后面排着的那些一并拒掉。 */
  queues.set(
    agentId,
    next.catch(() => undefined),
  )

  return next
}

/*
 * 线上的形状只有一份，它在生成绑定里。
 *
 * 这个文件此前手抄了三份：AgentCliRequest、AgentCliResult、AgentConfigSnapshot ——
 * 而 export_bindings.rs 的文件头逐字写着 renderer code must not redefine native DTOs。
 *
 * 抄本已经抄错了一处，还是有后果的那种：密钥尾号在 Rust 侧是 BTreeMap，线上因此是
 * Partial<Record<string, string>>（任何一个键都可能缺席），抄本写的是
 * Record<string, string>。读一个没配过的 provider，运行期拿到 undefined，类型却说
 * 那是 string。
 */
export type { AgentCliResult, AgentConfigSnapshot, AgentInstallStatus, ProviderProbeOutcome }

/*
 * 安装那条路不进 inOrder。
 *
 * 那个队列排的是 config.toml 的写者；安装动的是全局 node_modules，两者没有共享资源，
 * 排在一起只会让「装一下」被一次几秒的密钥写入挡住。它自己的问题是另一个：用户会连点，
 * 而每一次点都是一个 npm 进程。同一把钥匙上已经在飞的那次直接复用 —— 这是 single-flight，
 * 不是节流：调用方拿到的仍然是真实那一次的结果。
 */
const flights = new Map<string, Promise<AgentInstallStatus>>()

function singleFlight(
  key: string,
  work: () => Promise<AgentInstallStatus>,
): Promise<AgentInstallStatus> {
  const flying = flights.get(key)

  if (flying !== undefined) {
    return flying
  }

  const started = work().finally(() => {
    flights.delete(key)
  })

  flights.set(key, started)

  return started
}

/**
 * 受控 CLI 调用的请求。受控 home 与可执行文件都由原生侧按 agentId 现算。
 *
 * 只覆写一格：args 对调用方是只读的，而线上要一个可变数组。其余原样取自生成绑定，
 * 字段说明也在那边 —— 与 agent.ts 的 launch 是同一手法。
 */
export interface AgentCliRequest extends Omit<NativeAgentCliRequest, 'args'> {
  readonly args: readonly string[]
}

/* readonly string[] 与线上要的 string[] 是两个类型，所以数组在这里复制一次。 */
function nativeCliRequest(request: AgentCliRequest): NativeAgentCliRequest {
  return { ...request, args: [...request.args] }
}

export interface AgentConfigBridge {
  readonly load: () => Promise<AgentConfigSnapshot>
  readonly saveAgents: (
    agents: readonly unknown[],
    defaultAgentId: string,
  ) => Promise<AgentConfigSnapshot>
  readonly execCli: (request: AgentCliRequest) => Promise<AgentCliResult>
  /**
   * 每个已配置 provider 的密钥尾号。只读现算，尽力而为：取不到就是空表。
   *
   * 缺席的 provider 没有这一格，不是空字符串 —— 线上就是这么说的，这一层不替它撒谎。
   */
  readonly loadKeyTails: (agentId: string) => Promise<Partial<Record<string, string>>>
  /** 受控 home 里当前的默认模型；没设过就是 null。为什么它是闸门，见生成绑定里 agentDefaultModel。 */
  readonly loadDefaultModel: (agentId: string) => Promise<string | null>
  /** 改写受控 home 里的 default_model。为什么不借 agent 的 CLI，见生成绑定里 agentSetDefaultModel。 */
  readonly saveDefaultModel: (agentId: string, alias: string) => Promise<void>
  /**
   * 这个 agent 的运行时装了没有、是不是最新。
   *
   * force 为假时命中原生侧 24 小时内的缓存，既不起进程也不走网络，界面可以随便调。
   */
  readonly loadInstallStatus: (agentId: string, force: boolean) => Promise<AgentInstallStatus>
  /** 安装或更新这个 agent 的运行时，完成后返回新的状态。 */
  readonly runInstall: (agentId: string) => Promise<AgentInstallStatus>
  /**
   * 拿一把刚收到的密钥问那家厂商认不认。不写任何东西，所以不进 inOrder 的队列 ——
   * 它既不改 config.toml，也不该被一次几秒的写入挡在后面。
   */
  readonly verifyProviderKey: (baseUrl: string, secret: string) => Promise<ProviderProbeOutcome>
}

export function createAgentConfigBridge(): AgentConfigBridge {
  return {
    load: () => throughIpc(() => commands.agentConfigGet()),

    /*
     * agents 是不透明 JSON —— Rust 侧把它声明成 JsonValue 就是这个意思，校验在
     * @poietica/agent-registry。断言只发生在这一行，不外泄给任何调用方。
     */
    saveAgents: (agents, defaultAgentId) =>
      throughIpc(() => commands.agentConfigSaveAgents(agents as JsonValue[], defaultAgentId)),

    execCli: (request) =>
      inOrder(request.agentId, () =>
        throughIpc(() => commands.agentCliExec(nativeCliRequest(request))),
      ),

    loadKeyTails: (agentId) => throughIpc(() => commands.agentKeyTails(agentId)),

    loadDefaultModel: (agentId) => throughIpc(() => commands.agentDefaultModel(agentId)),

    saveDefaultModel: (agentId, alias) =>
      inOrder(agentId, async () => {
        await throughIpc(() => commands.agentSetDefaultModel(agentId, alias))
      }),

    loadInstallStatus: (agentId, force) =>
      singleFlight(`status:${agentId}:${String(force)}`, () =>
        throughIpc(() => commands.agentInstallStatus(agentId, force)),
      ),

    runInstall: (agentId) =>
      singleFlight(`install:${agentId}`, () => throughIpc(() => commands.agentInstallRun(agentId))),

    verifyProviderKey: (baseUrl, secret) =>
      throughIpc(() => commands.providerProbeKey(baseUrl, secret)),
  }
}
