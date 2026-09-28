import { createExternalStore } from '@poietica/external-store'
import { assertUnreachable, warn } from '@poietica/problem'
import type { BrowserControl, BrowserSettingsPatch } from './capability'
import {
  CAPABILITIES_UNREAD,
  CAPABILITY_COMMAND_IDLE,
  type CapabilityCommand,
  type CapabilityInventory,
} from './capability'
import type { CapabilityGateway } from './capability-gateway'
import type { Launcher } from './catalog/builtin'
import type { ExtensionGateway } from './extension-gateway'
import { type PluginFetchPlan, planFetch } from './fetch-plan'
import {
  describeInstallSource,
  type PluginInstallSource,
  type PluginTrustTier,
  requiresInstallConfirmation,
  UNLISTED_TRUST,
} from './install-source'

import type { InstalledPlugin } from './installation'
import { decodePluginManifest, type PluginDiagnostic, type PluginManifest } from './manifest'
import {
  beginFetch,
  completeFetch,
  failFetch,
  latestCatalog,
  MARKETPLACE_ABSENT,
  type MarketplaceState,
  shouldFetchOnOpen,
} from './marketplace'
import {
  addMcpServers,
  type DeclaredMcpServer,
  decodeMcpConfig,
  type McpEntry,
  mcpServerBodyInConfig,
  removeMcpServer,
  setMcpServerEnabledInConfig,
  upsertMcpServer,
} from './mcp-config'
import { type ResolvedMcpServer, resolveMcpServers } from './mcp-servers'
import type { ContributionOrigin } from './origin'
import { type InstalledSkill, readSkills, skillFrontmatter } from './skill'

/**
 * 「装了什么、开没开、市场上有什么」的唯一持有者。装了什么由 agent 自己那份
 * installed.json 说了算：每一次改动都先写那个文件，写成了才发布快照。反向的窗口
 * 不由我们决定 —— 官方文档逐字「Plugin changes apply after /reload or in new sessions」。
 * 不拆：全部动作共享同一条串行写队列与同一个发布点，且都受「先写文件、写成才发布」
 * 这条顺序不变量约束。
 */

/** 用户在命令行上装的插件，但不在受控 home 账本里 —— 存在只为说出「你在别处装过它」，否则目录卡片写「可安装」与人的记忆对不上。 */
export interface ForeignPlugin {
  readonly pluginId: string
  /** 人当初给命令行的地址；缺席表示那条记录没记。 */
  readonly originalSource: string | undefined
  /** 读到它的那本账在哪。 */
  readonly location: string
}

export interface PluginsViewModel {
  readonly plugins: readonly InstalledPlugin[]
  /* 内置的、这台机器上配好的、插件带来的，同一张 MCP 表。 */
  readonly mcpServers: readonly ResolvedMcpServer[]
  readonly mcpPending: number
  readonly mcpFailure: string | undefined
  /** 命令行上装过、这里没有装的那些。不参与任何状态计算：装了什么只有受控 home 那本账说得出来。 */
  readonly foreign: readonly ForeignPlugin[]
  /** 本机 agent 报的能力清单：某项能力装到哪一步，只有它说得出。 */
  readonly capabilities: CapabilityInventory
  /** agent 的浏览器控制设置：开关、有头无头、CDP 附着。 */
  readonly browser: BrowserControl
  /** 一次能力安装的进行时。 */
  readonly capabilityCommand: CapabilityCommand
  readonly marketplace: MarketplaceState
  readonly install: InstallFlow
  /** 本机 skills/ 里装着的技能：装了哪些、开没开，这一格说了算。 */
  readonly ownedSkills: readonly InstalledSkill[]
  /** 技能操作失败时保留原目录投影，并把原因交给界面。 */
  readonly skillFailure: string | undefined
  /** 技能安装的进行时。没有确认步：一键装完，失败原因落在这里。 */
  readonly skillInstall: InstallFlow
  /** 首帧与「读完了确实一个都没装」不是同一件事，空态因此不会闪。 */
  readonly loaded: boolean
}

export interface IdleInstall {
  readonly kind: 'idle'
}

export interface StagingInstall {
  readonly kind: 'staging'
  readonly source: PluginInstallSource
}

/* 已解到暂存区、等人点头的那一份：人看见的是解码后的清单本身，不点就一直停在这格。 */
export interface StagedInstall {
  readonly kind: 'staged'
  readonly stagingId: string
  readonly source: PluginInstallSource
  /* 取用时的那段子目录，认领的是同一层，要跟着走到 commit。 */
  readonly subdirectory: string | null
  readonly manifest: PluginManifest
  readonly diagnostics: readonly PluginDiagnostic[]
  readonly trust: PluginTrustTier
}

export interface RefusedInstall {
  readonly kind: 'refused'
  readonly source: PluginInstallSource
  readonly reason: string
}

export type InstallFlow = IdleInstall | RefusedInstall | StagedInstall | StagingInstall

const INSTALL_IDLE: InstallFlow = { kind: 'idle' }

/* 视图模型里两格安装状态的键。两条流程按它分账世代号，也按它发布状态。 */
type InstallFlowKey = 'install' | 'skillInstall'

export interface PluginStore {
  readonly getSnapshot: () => PluginsViewModel
  readonly subscribe: (listener: () => void) => () => void
  /**
   * 读账本、读技能目录、读环境、取市场目录，然后投一次屏幕。
   *
   * 交回首扫的落定：MCP 名册在开会话那一刻被采样、此后不再重挂，要先等到它；市场
   * 目录是网络往返，不在这份落定里。重复调用幂等，交回同一份落定。
   */
  readonly start: () => Promise<void>
  /** 让下一次 start() 重新首扫。谁 start 谁 stop。 */
  readonly stop: () => void
  /** 重新读 agent 的浏览器控制设置（电脑控制页的重试也走它）。 */
  readonly refreshBrowserSettings: () => void
  /** 写浏览器控制设置；缺席的格不改。 */
  readonly setBrowserSettings: (patch: BrowserSettingsPatch) => void
  readonly setEnabled: (pluginId: string, enabled: boolean) => void
  /**
   * 拨动一台服务器。收的是来源而不是插件号：mcp.json 里不属于任何插件的没有真插件号。
   * 开关落在哪份真相由来源说了算：插件的落账本，mcp.json 的落文件本身的 enabled ——
   * 与 CLI 拨的是同一格。
   */
  readonly setMcpServerEnabled: (
    target: ContributionOrigin,
    server: string,
    enabled: boolean,
  ) => void
  /** 把一台服务器写进这个 agent 的 mcp.json —— 内置名单的一键安装。条目正文由调用方给，同名条目整个换掉：「重装」与「改配置再装」是同一个动作。 */
  readonly installEnvironmentServer: (name: string, body: Record<string, unknown>) => void
  /** stdio 条目的启动式解析，内置名单的安装卡片要先把「没有那个程序」说出来。 */
  readonly resolveLauncher: (program: string) => Promise<Launcher | null>
  /** 从 mcp.json 里删掉一台。名单上有它的卡片会拨回「可安装」，随时装得回来。 */
  readonly removeEnvironmentServer: (name: string) => Promise<boolean>
  readonly addEnvironmentServers: (entries: readonly McpEntry[]) => Promise<boolean>
  readonly refreshMcpServers: () => void
  /**
   * 本进程托管的那台服务器在 mcp.json 里的条目，对齐到当前地址；body 缺席就拆掉条目。
   * 端口每次启动由内核分配，这趟要在 agent 进程起来之前跑完（kap 那一刻读 mcp.json）。
   * 与界面上的增删改同队列、同一条读—改—写：mcp.json 只有一个写者。
   */
  readonly reconcileHostedServer: (
    name: string,
    body: Record<string, unknown> | null,
  ) => Promise<void>
  readonly remove: (pluginId: string) => void
  /**
   * 开始一次安装：下载、解压到暂存区。收解好的结构不是字符串 —— 渲染成字符串再解析
   * 回来会丢掉子目录（网页地址里没有无歧义的写法）。
   */
  readonly beginInstall: (source: PluginInstallSource) => void
  readonly confirmInstall: () => void
  readonly cancelInstall: () => void
  /** 放弃在途的技能安装。技能没有确认步，所以这里只有「不要了」一个语义。 */
  readonly cancelSkillInstall: () => void
  /** 请本机 kap 装一项能力。幂等，这里不下载任何东西：取件、解压、装到哪全在 kap 那一侧。 */
  readonly installCapability: (capabilityId: string) => void
  /** 重新读取 KAP 能力；连接不存在时由原生运行时建立。 */
  readonly refreshCapabilities: () => void
  readonly refreshMarketplace: () => void
  /** 装一个技能：取件、解压、按前言取名、落进 skills/<name>/。无确认步：技能是提示词文本，风险档比插件低一级。 */
  readonly installSkill: (source: PluginInstallSource) => void
  /** 停用或启用一个技能：原生侧改 SKILL.md 的名字，与 CLI 同一判据；正文留在盘上，停用不是删除。 */
  readonly setSkillEnabled: (name: string, enabled: boolean) => void
  /** 移到系统回收站，保留可恢复性。 */
  readonly trashInstalledSkill: (name: string) => void
  readonly retrySkills: () => void
}

interface PluginStoreOptions {
  /** 账本与暂存区的唯一写路。必填：组合根忘了注入编译器当场拦下。 */
  readonly gateway: ExtensionGateway
  /** 本机能力账本的唯一读写路。 */
  readonly capability: CapabilityGateway
  /** 市场目录地址。相对来源相对的就是它：换一个地址条目跟着换一个仓库，不需要第二处配置。 */
  readonly marketplaceUrl: string
  /** 领域层不摸时钟，时钟从这里交进去。测试因此不需要冻结全局时间。 */
  readonly now: () => string
}

/*
 * 账本里一条记录解码后的样子。开关与清单在同一条记录里，拨开关就地改 enabled 再发布，
 * 不必回头重读清单（VS Code 切 enablement 不触发 extension scan，同理）。
 */
interface ScannedPlugin {
  readonly pluginId: string
  readonly manifest: PluginManifest
  readonly diagnostics: readonly PluginDiagnostic[]
  /** 清单读不出来的记录仍然装着，但它不受那个开关支配。 */
  readonly readable: boolean
  readonly enabled: boolean
  readonly installedAt: string | undefined
  readonly disabledMcpServers: readonly string[]
}

/* 官方 InstalledRecord.source 的三个取值。取用方式一一对应，不另立名目。 */
function sourceKindOf(source: PluginInstallSource): string {
  switch (source.kind) {
    case 'directory':
      return 'local-path'
    case 'archive':
      return 'zip-url'
    case 'github':
      return 'github'
    default:
      return assertUnreachable(source)
  }
}

export function createPluginStore(options: PluginStoreOptions): PluginStore {
  const { gateway } = options
  const store = createExternalStore<PluginsViewModel>({ read: () => snapshot })

  let scanned: readonly ScannedPlugin[] = []
  /* 最近一次成功读取的配置投影；读取失败不清空。 */
  let environment: readonly DeclaredMcpServer[] = []
  /* 另一本账里的那些；读不出来就是空，不意味着装了什么。 */
  let foreignRecords: readonly ForeignPlugin[] = []

  let snapshot: PluginsViewModel = {
    plugins: [],
    mcpServers: [],
    mcpPending: 0,
    mcpFailure: undefined,
    foreign: [],
    capabilities: CAPABILITIES_UNREAD,
    browser: { kind: 'unread' },
    capabilityCommand: CAPABILITY_COMMAND_IDLE,
    marketplace: MARKETPLACE_ABSENT,
    install: INSTALL_IDLE,
    ownedSkills: [],
    skillFailure: undefined,
    skillInstall: INSTALL_IDLE,
    loaded: false,
  }

  /*
   * 状态迁移串行走一条队列：并发跑两次读—改—写时，后写的那次带着更旧的账本，会把
   * 第一个开关悄悄拨回去。启动那一趟也在这条队列上，不能与一次拨动交错。
   */
  let queue: Promise<void> = Promise.resolve()

  /* 首扫的落定。开发期的挂载—卸载—再挂载会让 start() 被调用两次：交回同一份。 */
  let ready: Promise<void> | null = null

  /*
   * 两条安装流程各自的世代号：取消改不了已经飞出去的那一趟取件，落定结果靠它判断
   * 自己是否过期。按流程分账 —— 共用一个计数器时，装一个技能会让在途的插件安装
   * 误判过期，而它那一格再没有人拨回去。
   */
  const epochs = { install: 0, skillInstall: 0 }

  /* 盘上那些目录的投影。 */
  let ownedSkills: readonly InstalledSkill[] = []

  function publish(next: Partial<PluginsViewModel>): void {
    snapshot = { ...snapshot, ...next }
    store.notify()
  }

  /* 背书来自目录，按插件号判：展示串不是标识，它换一个写法就不等了。 */
  function listing(pluginId: string) {
    return latestCatalog(snapshot.marketplace)?.entries.find((entry) => entry.id === pluginId)
  }

  /* 账本 + 清单投成屏幕上那一份，没有 I/O。走到这里账本已读过一遍，loaded 恒真。 */
  function republish(): void {
    const plugins: readonly InstalledPlugin[] = scanned.map((entry) => {
      const listed = listing(entry.pluginId)

      return {
        pluginId: entry.pluginId,
        manifest: entry.manifest,
        source: listed?.source,
        trust: listed?.trust ?? UNLISTED_TRUST,
        enabled: entry.readable && entry.enabled,
        installedAt: entry.installedAt,
        disabledMcpServers: entry.disabledMcpServers,
        diagnostics: entry.diagnostics,
      }
    })

    const here = new Set(plugins.map((plugin) => plugin.pluginId))

    publish({
      plugins,
      mcpServers: resolveMcpServers({ environment, plugins }),
      /* 两边都装着的不算「别处装过」：那一条已经在上面的 plugins 里了。 */
      foreign: foreignRecords.filter((record) => !here.has(record.pluginId)),
      ownedSkills,
      loaded: true,
    })
  }

  /*
   * 解一条记录：账本里那几格，加上清单原文解出来的形状，没有 I/O。清单原文由原生侧
   * 列举时一并交过来，开销只是一次 JSON 解析加一次 schema 校验（此前每条声明路径
   * 一趟原生读目录，读出的技能与命令只有 CLI 一个读者）。
   */
  function scan(payload: {
    readonly pluginId: string
    readonly manifestJson: string
    readonly enabled: boolean
    readonly installedAt: string | null
    readonly originalSource: string | null
    readonly disabledMcpServers: string[]
  }): ScannedPlugin {
    const shared = {
      pluginId: payload.pluginId,
      enabled: payload.enabled,
      installedAt: payload.installedAt ?? undefined,
      disabledMcpServers: payload.disabledMcpServers,
    }

    const decoded = decodeManifestJson(payload.pluginId, payload.manifestJson)

    if (decoded.kind === 'rejected') {
      return {
        ...shared,
        manifest: unreadableManifest(payload.pluginId),
        diagnostics: decoded.diagnostics,
        readable: false,
      }
    }

    return {
      ...shared,
      manifest: decoded.manifest,
      diagnostics: decoded.diagnostics,
      readable: true,
    }
  }

  /*
   * 这个 agent 自己那份 mcp.json 里已经配好的服务器，不是「这台机器上的所有 MCP」：
   * 别家的配置文件它一个都不读，列出来只会得到一排拨了不生效的开关。哪份算数由
   * 原生侧的 agent_home_directory 说了算。
   */
  async function readEnvironment(): Promise<void> {
    const file = await gateway.readEnvironmentMcpConfig()

    if (file.contents === null) {
      environment = []

      return
    }

    let document: unknown
    try {
      document = JSON.parse(file.contents)
    } catch {
      throw new Error('MCP 配置不是有效 JSON；未修改文件。')
    }
    const decoded = decodeMcpConfig({ kind: 'user', location: file.location }, document)
    if (decoded.malformed) {
      throw new Error('MCP 配置结构无效；未修改文件。')
    }
    environment = decoded.servers
  }

  /* 装了什么，agent 的账本说了算。开关与清单在同一条记录里，一次读齐。 */
  async function rescan(): Promise<void> {
    const payloads = await gateway.listPlugins()

    scanned = payloads.map(scan)
  }

  /* 技能装了什么，skills/ 目录说了算。前言在 skill.ts 解一次。 */
  async function rescanSkills(): Promise<void> {
    ownedSkills = readSkills(await gateway.listSkills())
    publish({ skillFailure: undefined })
  }

  /*
   * 另一本账 —— 用户自己那个家里的那一份，只读，不算进「装了什么」：受控 home 生效时
   * 会话只装载受控账本，这份里的插件在这里确实没装上，目录卡片写「可安装」是真话。
   * null 表示这台机器上没有第二本账（受控 home 没有生效，两边读同一个文件）。
   */
  async function readForeign(): Promise<void> {
    const ledger = await gateway.listForeignPlugins()

    foreignRecords =
      ledger === null
        ? []
        : ledger.plugins.map((record) => ({
            pluginId: record.pluginId,
            originalSource: record.originalSource ?? undefined,
            location: ledger.location,
          }))
  }

  /*
   * 写成了才发布，失败不动屏幕：每一次改动都是「先写 agent 会读的那个文件，再改屏幕」，
   * 没有第三种顺序。
   */
  function commit(what: string, write: () => Promise<void>, after: () => void): Promise<void> {
    queue = queue.then(async () => {
      try {
        await write()
      } catch (cause: unknown) {
        warn(what, { scope: 'plugins', cause })

        return
      }

      after()
    })

    return queue
  }

  /*
   * mcp.json 的一次读—改—写，原文连同改好的正文一起交给原生侧（写入先比对再落盘）：
   * 队列串住了本进程内的改写，比对挡的是进程外的写者（终端里的 CLI 或人手改）。
   */
  function performMcp(what: string, action: () => Promise<void>): Promise<boolean> {
    publish({ mcpPending: snapshot.mcpPending + 1 })
    const operation = queue.then(async () => {
      publish({ mcpFailure: undefined })
      try {
        await action()
        republish()
        return true
      } catch {
        // 配置可能含密钥，不记录原文或第三方解析器的异常载荷。
        warn(what, { scope: 'plugins' })
        publish({ mcpFailure: what })
        return false
      } finally {
        publish({ mcpPending: snapshot.mcpPending - 1 })
      }
    })
    queue = operation.then(() => undefined)
    return operation
  }

  function rewriteEnvironment(
    what: string,
    transform: (contents: string | null) => string | null,
  ): Promise<boolean> {
    return performMcp(what, async () => {
      const file = await gateway.readEnvironmentMcpConfig()
      const contents = transform(file.contents)
      if (contents !== null && contents !== file.contents) {
        await gateway.writeEnvironmentMcpConfig(file.contents, contents)
      }
      await readEnvironment()
    })
  }

  function trustOf(pluginId: string): PluginTrustTier {
    return listing(pluginId)?.trust ?? UNLISTED_TRUST
  }

  /* 启动时那几趟只读取用：一趟坏了不拖累另外几趟进屏幕，兜底值由调用方给。 */
  async function guard(
    what: string,
    read: () => Promise<void>,
    fallback: () => void,
  ): Promise<void> {
    try {
      await read()
    } catch (cause: unknown) {
      warn(what, { scope: 'plugins', cause })

      fallback()
    }
  }

  /* 上一次拉下来、存在盘上那一份。它决定了「算不算从来没取过」。 */
  async function loadCatalog(): Promise<void> {
    try {
      const contents = await gateway.readPluginCatalog()

      if (contents === null) {
        return
      }

      publish({
        marketplace: completeFetch(
          snapshot.marketplace,
          JSON.parse(contents),
          options.marketplaceUrl,
        ),
      })
    } catch (cause: unknown) {
      warn('本地市场目录读不出来', { scope: 'plugins', cause })
    }
  }

  async function fetchCatalog(): Promise<void> {
    publish({ marketplace: beginFetch(snapshot.marketplace) })

    try {
      const contents = await gateway.refreshPluginCatalog(options.marketplaceUrl)

      publish({
        marketplace: completeFetch(
          snapshot.marketplace,
          JSON.parse(contents),
          options.marketplaceUrl,
        ),
      })
    } catch (cause: unknown) {
      publish({
        marketplace: failFetch(snapshot.marketplace, reasonOf(cause)),
      })
    }
  }

  /* 能力清单只有一个读者，也只有一个写者：这一格。 */
  async function readCapabilities(): Promise<void> {
    try {
      const capabilities = await options.capability.readCapabilities()

      publish({ capabilities: { kind: 'reported', capabilities } })
    } catch (cause: unknown) {
      const reason = reasonOf(cause)

      warn('本机能力清单读取失败', { scope: 'plugins', cause })
      publish({ capabilities: { kind: 'failed', reason } })
    }
  }

  async function readBrowserSettings(): Promise<void> {
    try {
      const [browser, appEndpoint] = await Promise.all([
        options.capability.readBrowserSettings(),
        options.capability.readAppBrowserEndpoint(),
      ])

      publish({ browser: { kind: 'ready', appEndpoint, ...browser } })
    } catch (cause: unknown) {
      const reason = reasonOf(cause)

      warn('浏览器控制设置读取失败', { scope: 'plugins', cause })
      publish({ browser: { kind: 'failed', reason } })
    }
  }

  async function writeBrowserSettings(patch: BrowserSettingsPatch): Promise<void> {
    try {
      const [browser, appEndpoint] = await Promise.all([
        options.capability.writeBrowserSettings(patch),
        options.capability.readAppBrowserEndpoint(),
      ])

      publish({ browser: { kind: 'ready', appEndpoint, ...browser } })
    } catch (cause: unknown) {
      const reason = reasonOf(cause)

      warn('浏览器控制设置写入失败', { scope: 'plugins', cause })
      publish({ browser: { kind: 'failed', reason } })
    }
  }

  let capabilityReadQueued = false

  function queueCapabilityRead(): void {
    if (capabilityReadQueued) {
      return
    }

    capabilityReadQueued = true
    queue = queue.then(readCapabilities).finally(() => {
      capabilityReadQueued = false
    })
  }

  function publishFlow(flow: InstallFlowKey, state: InstallFlow): void {
    publish(flow === 'install' ? { install: state } : { skillInstall: state })
  }

  function refuse(flow: InstallFlowKey, source: PluginInstallSource, cause: unknown): void {
    publishFlow(flow, {
      kind: 'refused',
      source,
      reason: reasonOf(cause),
    })
  }

  /*
   * 取件—暂存—认领这一趟，两条流程同一条代码路径，差别只是三个参数 —— 此前各写
   * 一遍，「过期就丢掉」那一支在技能那边漏了一半。过期分支不发布：取消那一路自己
   * 发过空闲，被顶掉的那路由顶掉它的那一次发过 staging，再发只会抹掉新的一格。
   */
  function beginStagedInstall<TStaged extends { readonly stagingId: string }>(
    flow: InstallFlowKey,
    source: PluginInstallSource,
    stage: (plan: PluginFetchPlan) => Promise<TStaged>,
    discard: (stagingId: string) => Promise<void>,
    accept: (staged: TStaged, subdirectory: string | null) => Promise<void>,
  ): void {
    const planning = planFetch(source)

    if (planning.kind === 'unplannable') {
      publishFlow(flow, { kind: 'refused', source, reason: planning.reason })

      return
    }

    epochs[flow] += 1
    const epoch = epochs[flow]
    const { plan } = planning
    const subdirectory = plan.kind === 'archive' ? plan.subdirectory : null

    publishFlow(flow, { kind: 'staging', source })

    queue = queue.then(async () => {
      let staged: TStaged

      try {
        staged = await stage(plan)
      } catch (cause: unknown) {
        refuse(flow, source, cause)

        return
      }

      if (epoch !== epochs[flow]) {
        await discard(staged.stagingId).catch((cause: unknown) => {
          warn('暂存目录没能清掉', { scope: 'plugins', cause })
        })

        return
      }

      try {
        await accept(staged, subdirectory)
      } catch (cause: unknown) {
        refuse(flow, source, cause)
      }
    })
  }

  /* 取消一条流程：往前一格，在途的那一趟落定时自行丢弃。 */
  function abandonInstall(flow: InstallFlowKey): void {
    epochs[flow] += 1

    publishFlow(flow, INSTALL_IDLE)
  }

  return {
    getSnapshot: () => snapshot,

    subscribe: store.subscribe,

    start() {
      if (ready !== null) {
        return ready
      }

      queue = queue.then(async () => {
        /*
         * 五趟互不依赖，一起等而不是排成五趟：每趟只读各自那个模块级变量，并发跑不会
         * 互相盖，首屏是一趟往返的时间。readCapabilities 不在这批里：那条 IPC 会顺手
         * 把 agent 拉起来，等于让开一条对话去等无关的事（见 queueCapabilityRead）。
         */
        await Promise.all([
          guard('插件列表读取失败', rescan, () => {
            scanned = []
          }),
          guard('技能目录读不出来', rescanSkills, () => {
            ownedSkills = []
            publish({ skillFailure: '技能目录读取失败，请重试。' })
          }),
          guard('命令行上那本插件账读不出来', readForeign, () => {
            foreignRecords = []
          }),
          guard('MCP 配置读取失败', readEnvironment, () => {
            publish({ mcpFailure: 'MCP 配置读取失败，请刷新重试；不会将失败当作空配置。' })
          }),
          loadCatalog(),
        ])

        /* 本地真相先上屏：MCP 名册在开会话那一刻被采样、此后不再重挂，就绪不能排在一次网络往返之后。 */
        republish()
      })

      ready = queue

      queue = queue.then(async () => {
        /* 能力清单与浏览器设置只喂电脑控制页那一格，谁都没在等它 —— 首屏落定之后才问。 */
        await readCapabilities()
        await readBrowserSettings()

        /*
         * 只在从来没取过时才自动拉一次，判据由 shouldFetchOnOpen 一处说了算（要等
         * loadCatalog 落定才问得出）。背书拿账本里的 pluginId 回目录里查，目录到了
         * 要再投一次 —— 但开一条对话不等这趟网络。
         */
        if (shouldFetchOnOpen(snapshot.marketplace)) {
          await fetchCatalog()

          republish()
        }
      })

      return ready
    },

    stop() {
      ready = null
    },

    setEnabled(pluginId, enabled) {
      commit(
        '插件开关没能写进 agent 的账本，屏幕上仍是账本里那一份',
        () => gateway.setPluginEnabled(pluginId, enabled),
        () => {
          /* 就地改这一条，不回头重读账本：清单一个字节没动，重扫一遍是白扫。 */
          scanned = scanned.map((entry) =>
            entry.pluginId === pluginId ? { ...entry, enabled } : entry,
          )

          republish()
          queueCapabilityRead()
        },
      )
    },

    setMcpServerEnabled(target, server, enabled) {
      if (target.kind === 'user') {
        void rewriteEnvironment('MCP 开关保存失败，请刷新并检查配置或写入权限。', (raw) =>
          setMcpServerEnabledInConfig(raw, server, enabled),
        )
        return
      }
      void performMcp('插件 MCP 开关保存失败，请刷新重试。', async () => {
        await gateway.setPluginMcpEnabled(target.pluginId, server, enabled)
        await rescan()
        queueCapabilityRead()
      })
    },

    installEnvironmentServer(name, body) {
      rewriteEnvironment('MCP 服务器没能写进 mcp.json，名单上那张卡片因此不动', (raw) =>
        upsertMcpServer(raw, name, body),
      )
    },

    resolveLauncher(program) {
      return gateway.resolveLauncher(program)
    },

    removeEnvironmentServer(name) {
      return rewriteEnvironment('删除 MCP 配置失败，请刷新并检查配置或写入权限。', (raw) =>
        removeMcpServer(raw, name),
      )
    },

    addEnvironmentServers(entries) {
      const submitted = structuredClone(entries)
      return rewriteEnvironment(
        'MCP 保存失败：请检查同名配置、配置格式或写入权限，再刷新重试。',
        (raw) => addMcpServers(raw, submitted),
      )
    },

    refreshMcpServers() {
      void performMcp('MCP 配置读取失败，请检查文件或权限后重试。', async () => {
        await readEnvironment()
        await rescan()
      })
    },

    async reconcileHostedServer(name, body) {
      const saved = await rewriteEnvironment('应用托管的 MCP 配置未能对齐。', (contents) => {
        const current = mcpServerBodyInConfig(contents, name)
        if (body === null) {
          return current === undefined ? contents : removeMcpServer(contents, name)
        }
        return current !== undefined && JSON.stringify(current) === JSON.stringify(body)
          ? contents
          : upsertMcpServer(contents, name, body)
      })
      if (!saved) {
        throw new Error('应用托管的 MCP 配置未能对齐。')
      }
    },

    /* 卸载 = 账本里那一条没了：装载与否由记录说了算，删记录就是卸载本身；托管副本由原生侧顺手清。 */
    remove(pluginId) {
      commit(
        '插件没能从 agent 的账本里删掉，界面因此不动',
        async () => {
          await gateway.removePlugin(pluginId)
          await rescan()
        },
        () => {
          republish()
          queueCapabilityRead()
        },
      )
    },

    beginInstall(source) {
      beginStagedInstall(
        'install',
        source,
        gateway.stagePlugin,
        gateway.discardStagedPlugin,
        async (staged, subdirectory) => {
          /* 诊断带上暂存号：插件号这一刻还不知道，而空串溯不回任何东西。 */
          const decoded = decodeManifestJson(staged.stagingId, staged.manifestJson)

          if (decoded.kind === 'rejected') {
            await gateway.discardStagedPlugin(staged.stagingId)
            publishFlow('install', {
              kind: 'refused',
              source,
              reason: decoded.diagnostics.map((entry) => entry.detail).join('; '),
            })

            return
          }

          const trust = trustOf(decoded.manifest.name)

          publishFlow('install', {
            kind: 'staged',
            stagingId: staged.stagingId,
            source,
            subdirectory,
            manifest: decoded.manifest,
            diagnostics: decoded.diagnostics,
            trust,
          })

          /* 官方来源不拦；其余一律等人点头，这条判据只有 install-source 说了算。 */
          if (!requiresInstallConfirmation(trust)) {
            adopt(staged.stagingId, decoded.manifest.name, source, subdirectory)
          }
        },
      )
    },

    confirmInstall() {
      const { install } = snapshot

      if (install.kind !== 'staged') {
        return
      }

      adopt(install.stagingId, install.manifest.name, install.source, install.subdirectory)
    },

    cancelSkillInstall() {
      abandonInstall('skillInstall')
    },

    cancelInstall() {
      const { install } = snapshot

      abandonInstall('install')

      if (install.kind !== 'staged') {
        return
      }

      queue = queue.then(async () => {
        try {
          await gateway.discardStagedPlugin(install.stagingId)
        } catch (cause: unknown) {
          warn('暂存目录没能清掉', { scope: 'plugins', cause })
        }
      })
    },

    installSkill(source) {
      beginStagedInstall(
        'skillInstall',
        source,
        gateway.stageSkill,
        gateway.discardStagedSkill,
        async (staged, subdirectory) => {
          /* 名字取自前言，缺席回落到子目录名。原生侧落盘前还会验一遍安全性。 */
          const fallback = subdirectory?.split('/').pop() ?? 'skill'
          const name = skillFrontmatter(staged.skillMd).name || fallback

          await gateway.commitSkill({ stagingId: staged.stagingId, name, subdirectory })

          publishFlow('skillInstall', INSTALL_IDLE)

          try {
            await rescanSkills()

            republish()
          } catch (cause: unknown) {
            warn('技能装好了，目录读不回来', { scope: 'plugins', cause })
          }
        },
      )
    },

    setSkillEnabled(name, enabled) {
      publish({ skillFailure: undefined })
      queue = queue.then(async () => {
        try {
          await gateway.setSkillEnabled(name, enabled)
          await rescanSkills()
          republish()
        } catch (cause: unknown) {
          warn('技能的开关没能落到磁盘上，界面因此不动', { scope: 'plugins', cause })
          publish({
            skillFailure: reasonOf(cause),
          })
        }
      })
    },

    trashInstalledSkill(name) {
      publish({ skillFailure: undefined })
      queue = queue.then(async () => {
        try {
          await gateway.trashSkill(name)
          await rescanSkills()
          republish()
        } catch (cause: unknown) {
          warn('技能没能移到系统回收站，界面因此不动', { scope: 'plugins', cause })
          publish({
            skillFailure: reasonOf(cause),
          })
        }
      })
    },

    retrySkills() {
      publish({ skillFailure: undefined })
      queue = queue.then(async () => {
        try {
          await rescanSkills()
          republish()
        } catch (cause: unknown) {
          warn('技能目录重读失败', { scope: 'plugins', cause })
          publish({
            skillFailure: reasonOf(cause),
          })
        }
      })
    },

    refreshBrowserSettings() {
      void readBrowserSettings()
    },
    setBrowserSettings(patch) {
      queue = queue.then(() => writeBrowserSettings(patch)).catch(() => undefined)
    },
    refreshCapabilities() {
      queueCapabilityRead()
    },

    installCapability(capabilityId) {
      publish({ capabilityCommand: { kind: 'pending', capabilityId } })

      queue = queue.then(async () => {
        try {
          const settled = await options.capability.installCapability(capabilityId)
          const capabilities =
            snapshot.capabilities.kind === 'reported'
              ? snapshot.capabilities.capabilities.some((item) => item.id === settled.id)
                ? snapshot.capabilities.capabilities.map((item) =>
                    item.id === settled.id ? settled : item,
                  )
                : [...snapshot.capabilities.capabilities, settled]
              : [settled]

          publish({ capabilities: { kind: 'reported', capabilities } })
          await rescan()
          publish({ capabilityCommand: CAPABILITY_COMMAND_IDLE })
          republish()
        } catch (cause: unknown) {
          await Promise.all([
            readCapabilities(),
            guard('能力安装失败后无法重新读取插件账本', rescan, () => {}),
          ])
          republish()
          publish({
            capabilityCommand: {
              kind: 'failed',
              capabilityId,
              reason: reasonOf(cause),
            },
          })
        }
      })
    },

    /* 目录换了背书就可能变，所以拉完要再投一次。 */
    refreshMarketplace() {
      queue = queue.then(async () => {
        await fetchCatalog()

        republish()
      })
    },
  }

  /*
   * 认领：副本进 managed/<id>/，账本里多一条。两件事在原生侧一次做完 —— 中间断开
   * 会留下一条指向空气的记录，而 agent 会照着它去装载。时刻从 options.now() 走。
   */
  function adopt(
    stagingId: string,
    pluginId: string,
    source: PluginInstallSource,
    subdirectory: string | null,
  ): void {
    queue = queue.then(async () => {
      try {
        await gateway.commitPlugin({
          stagingId,
          pluginId,
          subdirectory,
          source: sourceKindOf(source),
          originalSource: describeInstallSource(source),
          installedAt: options.now(),
        })
      } catch (cause: unknown) {
        publish({
          install: {
            kind: 'refused',
            source,
            reason: reasonOf(cause),
          },
        })

        return
      }

      publish({ install: INSTALL_IDLE })

      try {
        await rescan()
      } catch (cause: unknown) {
        warn('插件装好了，账本读不回来', { scope: 'plugins', cause })

        return
      }

      republish()
      queueCapabilityRead()
    })
  }
}

/* 清单读不出来的记录仍占一行：抹掉它，人只会看到「我明明装了它却不见了」。 */
function unreadableManifest(name: string): PluginManifest {
  return {
    name,
    displayName: name,
    description: undefined,
    version: undefined,
    developerName: undefined,
    homepage: undefined,
    capabilities: [],
    skillRoots: [],
    agentRoots: [],
    commandRoots: [],
    mcpServerNames: [],
    sessionStartSkill: undefined,
    skillInstructions: undefined,
    promptSources: [],
  }
}

function reasonOf(cause: unknown): string {
  return reasonOf(cause)
}

function decodeManifestJson(pluginId: string, contents: string) {
  try {
    return decodePluginManifest(JSON.parse(contents))
  } catch (cause: unknown) {
    const diagnostics: PluginDiagnostic[] = [
      {
        code: 'manifest-invalid',
        pluginId,
        detail: reasonOf(cause),
      },
    ]

    return { kind: 'rejected' as const, diagnostics }
  }
}
