import * as v from 'valibot'
import type { AgentDescriptor } from './agent-descriptor'
import { agentRoster } from './agents'

/** 会话配置值。对应 ACP 的 ConfigOption currentValue（string | boolean）。 */
export type AgentConfigOptionValue = string | boolean

/**
 * 一个 ACP agent 的接入档案：这台机器上，用户为这一家 agent 做的选择。
 *
 * 只有四格，而且每一格都真的属于用户。此前还有七格 —— displayName、command、
 * args、homeVar、registryKeyVar、ownHomeDirectory、install —— 它们描述的是「这
 * 一家 agent 是什么」，那件事由二进制里的 AgentDescriptor 说了算：名单是封闭
 * 的（见 agents.ts），界面上没有、也不会有一个能自带命令的入口。
 *
 * 那七格不是没用，是从来没被用过一次：reconcileAcpAgentProfiles 每次读都拿内置
 * 值把它们逐一覆盖回去。写进磁盘只为了下一次读出来时被扔掉，中间那段路上却要
 * 一整套针对不可信输入的校验陪着走 —— 反 shell 注入、npm 包名、目录名不许带分
 * 隔符。防的是一个不存在的输入源。
 *
 * 现在 command 在磁盘上没有产地，所以「一份被改坏的档案变成一次任意命令执行」
 * 这条路不是被正则拦住的，是结构上不存在。
 *
 * 这里刻意没有\"收藏了哪些模型\"：那份状态只存在提供方档案里一处。也没有\"支持哪些
 * 模型\"，因为那是会话在 session/new 之后才报告的事。
 */
export interface AgentProfile {
  /** 名单里的哪一家。不在名单里的档案会在物化时被移除。 */
  readonly id: string
  readonly cwd?: string | undefined
  /**
   * 非敏感环境变量，会原样落盘。
   *
   * 密钥永远不在这里，也不在别处：它由界面随 AgentConfigStore.execCli 的一次
   * 调用交给 agent 官方 CLI，写进 agent 自己的配置文件之后就与我们无关。我们
   * 不注入密钥环境变量，也不拼对方的配置文件格式。
   *
   * 受控 home 那个变量名不在这里 —— 它归二进制（AgentDescriptor.homeVar），
   * 值由原生侧的 launch_env 现算。
   */
  readonly env: Readonly<Record<string, string>>
  readonly defaultConfigOptions: Readonly<Record<string, AgentConfigOptionValue>>
  /*
   * 以下四格不属于用户，用户也填不出来 —— 它们是 AgentDescriptor 往磁盘上的
   * 一次单向投影，reconcileAcpAgentProfiles 每次无条件覆盖。
   *
   * 为什么必须落盘：原生侧那五个读取点（commands/agent_setup/profile.rs 的
   * agent_program、home_var_of、own_home_of、agent_install_spec、
   * declared_env_of）读的就是磁盘上这条档案。名单在 TypeScript 里，那个进程读
   * 不到它，agents.json 是两侧唯一的接触面 —— 这几格一旦缺席，home_var_of 恒为
   * None，受控 home 那个变量就不会被设上，agent 会去读用户全局的配置。
   *
   * 为什么这不是把「任意命令执行」放回来：值只有一个产地。磁盘上写着什么都不
   * 作数，下一次启动就被描述符里的值盖掉;原生侧的 validate_program 仍然独立
   * 校验一遍。从前那七格是「读时覆盖、落盘保留用户值」,这里是落盘即覆盖。
   */
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly homeVar?: string | undefined
  readonly ownHomeDirectory?: string | undefined
  readonly install?: Readonly<{ packageName: string; versionArgs: readonly string[] }> | undefined
}

export interface AcpAgentProfileSet {
  readonly profiles: readonly AgentProfile[]
  readonly defaultProfileId: string
}

export type AcpAgentProfileParse =
  | { readonly ok: true; readonly profile: AgentProfile }
  | { readonly ok: false; readonly issue: string }

/** 容错解析的结果：坏条目被丢弃并汇报，好条目照常可用。 */
export interface AcpAgentProfileSetParse {
  readonly value: AcpAgentProfileSet
  readonly issues: readonly string[]
  /**
   * value 不是从输入里解析出来的，是内置档案顶上去的。
   *
   * 没有这一格的时候，value 同时承担两种含义 ——「磁盘上写着这些」和「磁盘没说，
   * 我替你编了这些」—— 而调用方分不出来。下游因此拿一个自己编的值去跟内置档案
   * 比对、问「变了吗」，答案恒为「没变」，于是首次启动的物化一次都没发生过：
   * 渲染层用着内存里的内置档案，原生层读磁盘只读到空文件，两半各说各话。
   *
   * 为真表示磁盘上那份还不作数，调用方应当把 value 物化下去。
   */
  readonly fallback: boolean
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

const MAX_TEXT = 512
const MAX_ENTRIES = 32
const MAX_PROFILES = 32

/*
 * 档案的形状就是下面这张表。
 *
 * 此前这里是一个手写的校验框架：一个 Parsed<T> 结果类型、一个 fail、两个
 * asRecord/asText 探针、七个 parseXxx 函数，最后由九段 if (!x.ok) return x 串
 * 起来 —— 240 行把\"每个字段长什么样\"这件声明式的事，写成了命令式的流程控制。
 *
 * 代价不是观感：接口手写一遍、校验再手写一遍，两份靠人对齐，给档案加一个字段
 * 而忘了补校验时编译器一声不吭，它只是静默地不再校验那一格。
 *
 * valibot 1.4.2 本来就在 pnpm-workspace.yaml 的 catalog 里。校验来源不可信的
 * 输入正是标准能力该上场的地方：模式即文档，类型由模式推出。
 *
 * 表比从前短，不是因为放松了，是因为不该由用户拥有的字段已经不在磁盘上了。
 * 留下的两格 cwd 与 env 仍然完全来自用户，它们的规则一个字都没有动。
 *
 * 每条规则都自带中文说法，因为这些话会出现在设置界面上。
 */
const text = (max: number, message: string) =>
  v.pipe(v.string(message), v.minLength(1, message), v.maxLength(max, message))

const envName = (message: string) => v.pipe(text(64, message), v.regex(ENV_NAME_PATTERN, message))

const ID_ISSUE = 'agent 标识只允许小写字母、数字与连字符，且以字母开头'
const PROFILE_ISSUE = 'agent 档案无法解析'

const ProfileSchema = v.object({
  id: v.pipe(text(32, ID_ISSUE), v.regex(ID_PATTERN, ID_ISSUE)),
  cwd: v.nullish(text(1024, '工作目录必须是非空字符串')),
  env: v.optional(
    v.pipe(
      v.record(
        envName('环境变量名不合法，应为大写字母、数字与下划线'),
        text(MAX_TEXT, '环境变量的值必须是字符串'),
        '环境变量必须是对象',
      ),
      v.check((env) => Object.keys(env).length <= MAX_ENTRIES, `环境变量不超过 ${MAX_ENTRIES} 项`),
    ),
    {},
  ),
  defaultConfigOptions: v.optional(
    v.record(
      text(64, '会话配置项 id 必须是非空字符串'),
      v.union([v.string(), v.boolean()], '会话配置值只能是字符串或布尔值'),
      '默认会话配置必须是对象',
    ),
    {},
  ),
  command: v.nullish(text(MAX_TEXT, '可执行文件名必须是非空字符串')),
  args: v.nullish(v.array(text(MAX_TEXT, '启动参数必须是字符串'))),
  homeVar: v.nullish(envName('home 变量名不合法，应为大写字母、数字与下划线')),
  ownHomeDirectory: v.nullish(text(64, '配置目录名必须是非空字符串')),
  install: v.nullish(
    v.object({
      packageName: text(214, '安装包名必须是非空字符串'),
      versionArgs: v.optional(v.array(text(MAX_TEXT, '版本参数必须是字符串')), []),
    }),
  ),
})

/*
 * 整份配置的信封。
 *
 * defaultProfileId 用 fallback 而不是让它报错：那一格填坏了只算没填，回落到
 * 第一个档案。一个错字不该让整份 agents.json 作废。
 */
const EnvelopeSchema = v.object({
  profiles: v.array(v.unknown()),
  defaultProfileId: v.fallback(
    v.nullish(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
    undefined,
  ),
})

/*
 * 缺席与 null 在磁盘上都表示\"没有这一项\"，在类型里只留 undefined 一种：
 * 让两种空值一路往下走，就是让每个下游都判两次。
 */
function shape(parsed: v.InferOutput<typeof ProfileSchema>): AgentProfile {
  return {
    id: parsed.id,
    cwd: parsed.cwd ?? undefined,
    env: parsed.env,
    defaultConfigOptions: parsed.defaultConfigOptions,
    command: parsed.command ?? undefined,
    args: parsed.args ?? undefined,
    homeVar: parsed.homeVar ?? undefined,
    ownHomeDirectory: parsed.ownHomeDirectory ?? undefined,
    install: parsed.install ?? undefined,
  }
}

/**
 * 校验一个来源不可信的 agent 档案。
 *
 * agents.json 可以被手改，所以它不可信 —— 但界面填不出档案：agent 名单是封闭的，
 * 用户在注册过的几家里选，选择本身只是一个 id。校验因此只面对磁盘这一个来源。
 */
export function parseAcpAgentProfile(input: unknown): AcpAgentProfileParse {
  const parsed = v.safeParse(ProfileSchema, input, { abortPipeEarly: true })

  if (!parsed.success) {
    return { ok: false, issue: parsed.issues[0]?.message ?? PROFILE_ISSUE }
  }

  return { ok: true, profile: shape(parsed.output) }
}

/**
 * 解析整份配置。
 *
 * 单个坏档案只会被丢弃并记一条 issue，不会让整份 agents.json 解析失败——
 * 否则用户手滑一个字符就会丢掉全部 agent。这是 Zed 设置层的处理方式。
 */
export function parseAcpAgentProfileSet(input: unknown): AcpAgentProfileSetParse {
  const envelope = v.safeParse(EnvelopeSchema, input)

  if (!envelope.success) {
    return {
      value: builtinAcpAgentProfileSet(),
      issues: ['agent 配置无法解析，已回退到内置档案'],
      fallback: true,
    }
  }

  const issues: string[] = []
  const profiles: AgentProfile[] = []

  for (const candidate of envelope.output.profiles.slice(0, MAX_PROFILES)) {
    const parsed = parseAcpAgentProfile(candidate)

    if (!parsed.ok) {
      issues.push(parsed.issue)
      continue
    }

    if (profiles.some((existing) => existing.id === parsed.profile.id)) {
      issues.push(`agent 标识重复，已忽略后一个：${parsed.profile.id}`)
      continue
    }

    profiles.push(parsed.profile)
  }

  const first = profiles[0]

  if (!first) {
    /*
     * 「磁盘上一条都没有」和「有，但全都用不了」是两件事，此前共用一句话。
     *
     * 前者是每一台新电脑的第一次启动 —— 不是配置出了问题，是还没开始。把它报成
     * issue，设置页第一屏就会挂一句「没有可用的 agent 档案」，而用户什么都没做错。
     * 后者是真的坏了，必须说出来，而且措辞要说清坏的是磁盘上那份。
     *
     * 两条路都要 fallback: true —— 内置档案得落到磁盘上，原生侧才查得到它。
     */
    const nothingOnDisk = envelope.output.profiles.length === 0

    return {
      value: builtinAcpAgentProfileSet(),
      issues: nothingOnDisk
        ? issues
        : [...issues, '配置里的 agent 档案都无法使用，已回退到内置档案'],
      fallback: true,
    }
  }

  const requested = envelope.output.defaultProfileId ?? undefined
  const matched = requested !== undefined && profiles.some((one) => one.id === requested)
  const defaultProfileId = matched && requested !== undefined ? requested : first.id

  if (requested !== undefined && !matched) {
    issues.push(`默认 agent 指向了不存在的档案，已改用 ${defaultProfileId}`)
  }

  return { value: { profiles, defaultProfileId }, issues, fallback: false }
}

/**
 * 名单里的这一家。不在名单里返回 undefined —— 那种档案由 reconcile 移除。
 */
function descriptorOf(agentId: string): AgentDescriptor | undefined {
  return agentRoster().find((agent) => agent.id === agentId)
}

/** 环境变量表逐键相等。键序不参与比较。 */
function sameEnv(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): boolean {
  const names = Object.keys(after)

  return (
    names.length === Object.keys(before).length &&
    names.every((name) => before[name] === after[name])
  )
}

/** 启动参数相等。缺席与空表是同一件事：都表示这一家不带参数。 */
function sameArgs(before: AgentProfile['args'], after: AgentProfile['args']): boolean {
  const one = before ?? []
  const two = after ?? []

  return one.length === two.length && one.every((arg, index) => arg === two[index])
}

/** 安装声明相等。 */
function sameInstall(before: AgentProfile['install'], after: AgentProfile['install']): boolean {
  if (before === undefined || after === undefined) {
    return before === after
  }

  return (
    before.packageName === after.packageName &&
    before.versionArgs.length === after.versionArgs.length &&
    before.versionArgs.every((arg, index) => arg === after.versionArgs[index])
  )
}

/**
 * 把一条落盘档案上「归二进制的那几格」对齐到描述符。
 *
 * 覆盖是无条件的,不是合并。这几格的产地只有一个,磁盘上写着什么都不作数 ——
 * 判据与原生侧那一行同源:launch_env_inner 让受控 home 后进去、压过
 * declared_env_of,因为「用户在 env 里手写的可能根本不成立」。
 *
 * env 是唯一例外,它同时装着用户自己的变量:用户的键保留,描述符声明的键压过
 * 同名项。把 acp-v2 的开关关掉,agent 直接起不来。
 *
 * 已经一致时原样返回同一个对象。调用方靠引用是否变化判断要不要物化,复制一份
 * 会让每次启动都报「档案变了」并白写一次磁盘。
 */
function withDescriptorFields(profile: AgentProfile): AgentProfile {
  const agent = descriptorOf(profile.id)

  if (agent === undefined) {
    return profile
  }

  const next: AgentProfile = {
    ...profile,
    env: { ...profile.env, ...(agent.launchEnv ?? {}) },
    command: agent.command,
    args: agent.args,
    homeVar: agent.homeVar,
    ownHomeDirectory: agent.ownHomeDirectory,
    install: agent.install,
  }

  const unchanged =
    profile.command === next.command &&
    sameArgs(profile.args, next.args) &&
    profile.homeVar === next.homeVar &&
    profile.ownHomeDirectory === next.ownHomeDirectory &&
    sameInstall(profile.install, next.install) &&
    sameEnv(profile.env, next.env)

  return unchanged ? profile : next
}

/** 起一个 agent 进程要说清的那件事。 */
export interface AgentLaunchSpec {
  readonly agentId: string
}

/**
 * 把一家 agent 翻成一次启动。
 *
 * 不带 argv。程序在哪、要几个参数，是「这台机器上」的事实：原生侧在搜索路径上
 * 解析用户自己装的那个 CLI。渲染进程答不出，而它此前答了 —— agent_program 的注释
 * 早就写着「它刻意不来自请求」，那句话对 CLI 那条路成立，对会话这条路一直不成立。
 */
export function agentLaunch(agent: AgentDescriptor): AgentLaunchSpec {
  return { agentId: agent.id }
}

/**
 * 内置 agent 的档案：一家一条，用户那几格都还是空的。
 *
 * 它不再从描述符里抄七个字段过来 —— 那些字段现在只有一个产地。
 */
export function builtinAcpAgentProfiles(): readonly [AgentProfile, ...AgentProfile[]] {
  const blank = (agent: AgentDescriptor): AgentProfile => ({
    id: agent.id,
    cwd: undefined,
    env: { ...(agent.launchEnv ?? {}) },
    defaultConfigOptions: {},
    command: agent.command,
    args: agent.args,
    homeVar: agent.homeVar,
    ownHomeDirectory: agent.ownHomeDirectory,
    install: agent.install,
  })
  const [first, ...rest] = agentRoster()

  return [blank(first), ...rest.map(blank)]
}

/*
 * 内置档案集。默认 id 由这一份档案自己的第一条推出 —— 此前它再去查一次名单，
 * 于是「默认哪一家」同时被名单顺序和档案集定义，两个产地。
 */
export function builtinAcpAgentProfileSet(): AcpAgentProfileSet {
  const profiles = builtinAcpAgentProfiles()

  return { profiles, defaultProfileId: profiles[0].id }
}

/** 一次物化的结果。changed 为真表示磁盘上那份与名单不一致。 */
export interface AcpAgentProfileReconcile {
  readonly profiles: readonly AgentProfile[]
  readonly changed: boolean
  /** 为了对齐名单而丢掉了什么。界面要说出来，不能默默改用户的文件。 */
  readonly issues: readonly string[]
}

/**
 * 把落盘的档案与二进制里的名单对齐。
 *
 * 此前这里要逐格比对七个字段（sameLaunchIdentity 与 sameInstall 两个函数），
 * 因为那七格既在磁盘上、又在二进制里，两份得对齐。现在它们只在二进制里，所以
 * 这里没有任何字段要比 —— 只剩名单本身要对齐。
 *
 * 陌生 id 现在移除，而不是原样保留。保留是上一版为「用户自带的 agent」留的余地，
 * 而那条路不存在：agents.ts 说得很清楚，名单是封闭的。留着它，设置页的下拉
 * 就会列出一家原生侧根本查不到程序的 agent，选中之后失败在一个与选择无关的地方。
 * 丢掉一行用户手写的配置必须说出来，所以它带一条 issue 出去。
 *
 * 名单里有、磁盘上没有的补上：接第二家 agent 时它得自己出现，而不是只对新用户出现。
 */
export function reconcileAcpAgentProfiles(
  profiles: readonly AgentProfile[],
): AcpAgentProfileReconcile {
  const known = new Set(agentRoster().map((agent) => agent.id))
  const issues: string[] = []

  const kept = profiles.filter((profile) => {
    if (known.has(profile.id)) {
      return true
    }

    issues.push(`配置里的 ${profile.id} 不是本软件支持的 agent，已从 agents.json 移除`)

    return false
  })

  /*
   * 归二进制的那几格要在这里对齐，不能只靠内置档案。
   *
   * 上一版这里只对齐 env 一格。那把一个通用问题当成了特例:原生侧还读 command、
   * homeVar、ownHomeDirectory、install,四格全在磁盘上没有产地。agent_program
   * 因此报「没有可执行文件」,home_var_of 恒为 None 让受控 home 那个变量从来没被
   * 设过 —— 后者从安装那天起就在静默降级,只是先前没有任何代码路径写过这个文件,
   * profile_of 更早一步就先失败了,所以谁都没看见。
   *
   * 已经装过这个软件的机器上，agents.json 里那条档案早就写好了（env 是一张空
   * 表），而内置档案只在磁盘上什么都没有时才顶上去。这个函数此前的注释说得很
   * 清楚：「现在没有任何字段要比 —— 只剩名单本身要对齐」。那句话对用户拥有的
   * 那几格成立，对二进制声明的这一格不成立 —— 它一旦缺席，agent 起不来。
   */
  const aligned = kept.map(withDescriptorFields)
  const drifted = aligned.some((profile, index) => profile !== kept[index])

  const missing = builtinAcpAgentProfiles().filter(
    (builtin) => !aligned.some((one) => one.id === builtin.id),
  )

  return {
    profiles: [...aligned, ...missing],
    changed: issues.length > 0 || missing.length > 0 || drifted,
    issues,
  }
}
