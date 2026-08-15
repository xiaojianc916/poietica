import type { AgentProfile } from '@poietica/agent-catalog'

/**
 * 一次受控的 agent CLI 调用。
 *
 * 没有 home 相关的字段：受控 home 由原生侧的 launch_env 现算，与 ACP 会话
 * 共用同一个产地。渲染层报一个路径过去，只会得到两条各自算出不同目录的
 * 管线，而那种错误在界面上表现为「明明配好了，模型列表却是空的」。
 */
export interface AgentCliInvocation {
  readonly agentId: string
  /**
   * 完整的子命令序列，例如 ['provider', 'list', '--json']。
   *
   * 第一项是子命令名，原生侧的白名单看的就是它。
   *
   * 可执行文件不在这里，与 home 同理：由原生侧按 agentId 从档案里取。渲染层
   * 报一个程序路径过去，而白名单只校验参数，那等于放行任意程序。
   */
  readonly args: readonly string[]
  /**
   * 要注入的凭据环境变量名。它不是秘密，只是个名字。
   *
   * 缺席即不注入 —— 只读的那几条调用没有凭据可给，不该被迫先声明再撤回。
   */
  readonly secretVar?: string
  /**
   * 凭据本身。
   *
   * 它只活到这次调用结束：注入子进程后，agent 的 CLI 把它写进 agent 自己的
   * 配置文件，两端都不留副本。所以「配没配过」不能问我们 —— 要问 agent 的
   * provider list。
   */
  readonly secretValue?: string
  /**
   * api.json 形状的目录文档：只在「从目录添加 provider」时携带。
   *
   * 对方的 catalog add 只吃一个 http(s) 的目录地址。文档由原生侧绑在一次性
   * loopback 服务上，并把官方的 --url 指过去 —— 整条写入因此不碰外网。不含密钥。
   */
  readonly catalogDocument?: string
  /**
   * 读这个 agent 的用户全局 home 而不是受控 home。只为一次性导入的只读探测
   * （provider list）使用；原生侧会拒掉任何带着它的写操作。
   */
  readonly useGlobalHome?: boolean
  /**
   * 从用户全局配置里取哪家 provider 的密钥来注入。只为一次性导入使用：
   * 密钥由原生侧取出直达子进程，不进渲染层。与 secretValue 互斥。
   */
  readonly secretFromGlobalProvider?: string
}

export interface AgentCliOutcome {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * 一次密钥探测的结论。
 *
 * 分成五种而不是成功/失败两种，是因为这五种里只有一种能说出「密钥不对」。把超时
 * 或 404 渲染成「你的密钥错了」，会让用户去改一把本来是对的钥匙 —— 那比不验证更糟。
 */
export type ProviderKeyVerdict =
  | 'accepted'
  | 'rejected'
  | 'forbidden'
  | 'unsupported'
  | 'unreachable'

export interface ProviderKeyProbe {
  readonly verdict: ProviderKeyVerdict
  /** HTTP 状态码；没拿到响应时为 0。 */
  readonly status: number
  /** 那家报回的模型 id。只有 accepted 时才可能非空。 */
  readonly modelIds: readonly string[]
}

export interface AgentConfigSnapshot {
  readonly agents: readonly AgentProfile[]
  readonly defaultAgentId: string
  /** 配置文件里被丢弃的坏条目。界面应该显示出来，而不是假装配置是干净的。 */
  readonly issues: readonly string[]
}

/**
 * ACP agent 接入配置的持久化端口。
 *
 * 落在独立的 agents.json，不进 AppSettings：agent 接入是设备级的运行环境配置，
 * 跟主题、快捷键这类偏好不是同一种东西，混在一起会让两边的迁移都变难。
 *
 * 模式 B 下，模型与 provider 的权威副本在各 agent 自己的配置文件里，由 agent
 * 进程自己 watch 并热重载 —— 所以这里没有「保存 provider」这个动作，写入统一
 * 经由 execCli 调用 agent 官方 CLI。我们不自己拼对方的配置文件格式。
 *
 * 候选模型也一样：agent 自己就会拉 models.dev，而写入要过它的校验，所以「有哪些
 * 模型可加」问它的 provider catalog list，不在这里存第二份目录。
 *
 * 密钥不存在这里，也不存在别处。它随 execCli 的一次调用交给 agent 的 CLI，写进
 * agent 自己的配置文件之后就与我们无关 —— 那份文件里它是明文，所以我们再存一份
 * 副本换不到安全，只换来一个要同步的第二处真相。
 */
/**
 * 这个 agent 的运行时在这台机器上处于什么状态。
 *
 * unmanaged：档案没说怎么装（用户自带的 agent）。
 * unknown：装着，但问不到最新版（离线、镜像不通）——「不知道」不是「该更新」。
 */
export type AgentInstallState =
  | 'unmanaged'
  | 'missing'
  | 'outdated'
  | 'current'
  /** 装着，但不是 pnpm/npm 装的 —— 我们不碰别人的安装。 */
  | 'external'
  | 'unknown'

export interface AgentInstallStatus {
  readonly state: AgentInstallState
  readonly installedVersion: string | null
  readonly latestVersion: string | null
  readonly packageName: string | null
}

export interface AgentConfigStore {
  readonly load: () => Promise<AgentConfigSnapshot>
  readonly saveAgents: (args: {
    readonly agents: readonly AgentProfile[]
    readonly defaultAgentId: string
  }) => Promise<AgentConfigSnapshot>
  readonly execCli: (invocation: AgentCliInvocation) => Promise<AgentCliOutcome>
  /*
   * 每个已配置 provider 的密钥尾号。只读现算：原生侧扫 agent 自己的 config.toml，
   * 只把最后 5 个字符交出来 —— 与「写经谁手」无关，官方 CLI 配置的也有。
   *
   * 键域是开放的：provider 名由对方的配置文件说了算，所以问一个没配过的
   * provider 要尾号，答案就是「没有」。此前这里写的是 Record<string, string>，
   * 声称任意字符串键都必然有值 —— 那不是一个更严的类型，那是一句假话，而
   * Rust 侧经 specta 生成出来的 Partial<Record<…>> 从一开始就没同意过它。
   *
   * 缺席的 provider 没有那一格，所以是 Partial：这张表的键空间是开放的，
   * Record<string, string> 的意思是任何字符串键都取得到一个 string，那是假的。
   * 原生侧是 BTreeMap，生成绑定照实说了，是中间这一层把 Partial 抹掉了。
   */
  readonly loadKeyTails: (agentId: string) => Promise<Readonly<Partial<Record<string, string>>>>
  /*
   * 顶层的 default_model，没有就是 null。
   *
   * 它不是偏好，是开会话的前提：ACP 的鉴权闸门第一条判的就是它在不在
   * （packages/agent-contract-adapter/src/server.ts 的 hasUsableConfiguredDefaultModel 逐字
   * `if (config.defaultModel === undefined) return false`）。所以界面要能说出
   * 「现在是哪个」和「一个都没有」，而不是让用户从一次 Authentication required
   * 里反推。
   */
  readonly loadDefaultModel: (agentId: string) => Promise<string | null>
  /*
   * 改写 default_model。
   *
   * 原地改受控 home 里的那一个键，不经 agent 的 CLI —— 官方唯一会写它的出口
   * （provider catalog add --default-model）是为「换掉一家 provider 的整份模型清单」
   * 设计的，先删后建，还要求把那一家的密钥再交一次。我们要改的是一个标量。
   *
   * 生效不需要重启 agent：它自己 watch 着那个文件。但 watcher 有延迟，所以调用方
   * 不要在返回后立刻回读 —— 界面该用乐观更新。
   */
  readonly saveDefaultModel: (agentId: string, alias: string) => Promise<void>
  /*
   * 拿刚收到的密钥问那家厂商认不认。
   *
   * 这不是保存的一部分：写入在它之前就已经完成，它的结论只决定界面上那一行说什么，
   * 任何结论都不回滚已经落盘的配置。写入成功而验证没成，是一个完全正常的组合 ——
   * 用户在飞机上配好密钥，下飞机照样能用。
   *
   * 密钥不经由这一层的任何存储：它随这一次调用去原生侧，发完即弃。地址由原生侧
   * 按白名单校验，不在名单里就回 unsupported，不会把密钥发出去。
   */
  readonly verifyProviderKey: (args: {
    readonly baseUrl: string
    readonly secret: string
  }) => Promise<ProviderKeyProbe>
  /*
   * 「刚才那次调用改了 agent 自己的配置。」
   *
   * 由发起写入的那一方说 —— 只有它知道自己写没写。放在 execCli 里自动判断就要在
   * 这一层维护一张「哪些子命令算写」的清单，而那张清单会和对方的 CLI 一起走样；
   * 更糟的是读也会触发失效，于是读→失效→读，转不停。
   *
   * 为什么需要它：模型清单的权威在 agent 自己的配置文件里，而进程内不止一处照着
   * 它建了内存副本（设置页一份、主界面工具条一份）。写入方与读取方彼此不认识,
   * 也不该认识 —— 它们只共用这一个端口，所以通道就开在这里。
   *
   * 这是 VS Code onDidChangeConfiguration、Zed SettingsStore::observe_global、
   * TanStack Query invalidateQueries 的同一个形状：失效入口属于 store，不属于
   * 某一个组件。此前这件事是 useAgentProviders 实例上的 reload 方法，只有设置页
   * 那棵子树够得着，主界面因此要等到下次启动。
   */
  /**
   * 装了没有、是不是最新。
   *
   * 默认读缓存（原生侧 24 小时 TTL），所以界面挂载时调它既不起进程也不走网络。
   * 只有用户明确要求刷新时才传 force。
   */
  readonly loadInstallStatus: (
    agentId: string,
    options?: { readonly force?: boolean },
  ) => Promise<AgentInstallStatus>
  /** 安装或更新这个 agent 的运行时，完成后返回新的状态。 */
  readonly runInstall: (agentId: string) => Promise<AgentInstallStatus>
  readonly notifyConfigChanged: () => void
  /** 听「配置变了」。返回退订。 */
  readonly subscribeConfigChanged: (listener: () => void) => () => void
}
