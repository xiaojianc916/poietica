import type { SessionCommand } from '@poietica/agent-contract'
import { assertUnreachable, warn } from '@poietica/core'
import {
  commitPlugin,
  commitSkill,
  discardStagedPlugin,
  discardStagedSkill,
  listForeignPlugins,
  listPlugins,
  listSkills,
  readEnvironmentMcpConfig,
  readPluginCatalog,
  refreshPluginCatalog,
  removePlugin,
  removeSkill,
  setPluginEnabled,
  setPluginMcpEnabled,
  stagePlugin,
  stageSkill,
  writeEnvironmentMcpConfig,
} from '@poietica/ipc'
import { type PluginFetchPlan, planFetch } from './fetch-plan'
import {
  describeInstallSource,
  type PluginInstallSource,
  type PluginTrustTier,
  requiresInstallConfirmation,
  UNLISTED_TRUST,
} from './install-source'

/**
 * 全局命令面板端口：提供不依赖会话的斜杠命令表。
 *
 * 与 SessionCommandsPort（按会话）不同，这一路在会话建立前就可用，
 * 用于新建对话入口的输入框斜杠菜单。
 */
export interface AgentPalettePort {
  readonly read: () => readonly SessionCommand[]
  readonly subscribe: (listener: () => void) => () => void
}

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
  type DeclaredMcpServer,
  decodeMcpConfig,
  mcpServerBodyInConfig,
  removeMcpServer,
  setMcpServerEnabledInConfig,
  upsertMcpServer,
} from './mcp-config'
import { type ResolvedMcpServer, resolveMcpServers } from './mcp-servers'
import type { ContributionOrigin } from './origin'
import { createSnapshotCache } from './registry/snapshot'
import { decodeSkillPayload, type InstalledSkill, parseSkillFrontmatter } from './skill'

/**
 * 「装了什么、开没开、市场上有什么」的唯一持有者。
 *
 * 装了什么由 agent 自己那份 installed.json 说了算 —— 同一个文件，`/plugins` 面板读它，
 * 会话装载读它，我们的界面也读它。屏幕上这份是它的投影：每一次改动都先写那个文件，
 * 写成了才发布快照，所以不存在「界面已经变了、agent 那边还没变」的窗口。
 *
 * 反过来的窗口是存在的，而且不由我们决定：官方文档逐字「Plugin changes apply after
 * /reload or in new sessions」。已经开着的那条会话不会自己更新。
 */

/**
 * 用户在命令行上装的一个插件。
 *
 * 它不是一个「已安装」的插件：受控 home 生效时，我们开出去的会话只装载受控 home 那本
 * 账里的插件。这一格存在的唯一理由是把「你在别处装过它」这句话说出来 —— 否则目录里
 * 那张卡片写着可安装，而人记得自己装过，屏幕与记忆对不上时人只会认为屏幕坏了。
 */
export interface ForeignPlugin {
  readonly pluginId: string
  /** 人当初给命令行的那一串地址。缺席表示那条记录没记，导入因此没有起点。 */
  readonly originalSource: string | undefined
  /** 读到它的那本账在哪。 */
  readonly location: string
}

export interface PluginsViewModel {
  readonly plugins: readonly InstalledPlugin[]
  /* 屏幕上那张 MCP 列表：内置的、这台机器上配好的、插件带来的，同一张表。 */
  readonly mcpServers: readonly ResolvedMcpServer[]
  /**
   * 命令行上装过、这里没有的那些。
   *
   * 它们不在 plugins 里，因为它们确实没有装在这里。这一格不参与任何状态计算：装了
   * 什么只有受控 home 那本账说得出来。
   */
  readonly foreign: readonly ForeignPlugin[]
  readonly marketplace: MarketplaceState
  readonly install: InstallFlow
  /**
   * 受控 home 的 skills/ 目录里装着的技能。目录即账本，这一格是它的投影：会话里能
   * 调用什么由 agent 报给那条会话，这一格只回答「这里装了什么」。
   */
  readonly skills: readonly InstalledSkill[]
  /** 技能安装的进行时。没有确认步：一键装完，失败原因落在这里。 */
  readonly skillInstall: InstallFlow
  /** 首帧与「读完了确实一个都没装」不是同一件事，空态因此不会闪。 */
  readonly loaded: boolean
  /** 斜杠菜单的候选表：不依赖会话的全局命令列表。 */
  readonly palette: readonly SessionCommand[]
}

export interface IdleInstall {
  readonly kind: 'idle'
}

export interface StagingInstall {
  readonly kind: 'staging'
  readonly source: PluginInstallSource
}

/*
 * 已经解到暂存区、等人点头的那一份。
 *
 * 确认这一步拿到的是解码之后的清单，所以人看见的是「要装的到底是什么」，而不是
 * 一句「确定要安装吗」。不点就一直停在这一格，账本上什么也没多。
 */
export interface StagedInstall {
  readonly kind: 'staged'
  readonly stagingId: string
  readonly source: PluginInstallSource
  /* 取用时用的那一段子目录。认领的是同一层，所以它要跟着走到 commit。 */
  readonly subdirectory: string | null
  readonly manifest: PluginManifest
  readonly diagnostics: readonly PluginDiagnostic[]
  readonly trust: PluginTrustTier
}

export interface RefusedInstall {
  readonly kind: 'refused'
  readonly reason: string
}

export type InstallFlow = IdleInstall | RefusedInstall | StagedInstall | StagingInstall

export const INSTALL_IDLE: InstallFlow = { kind: 'idle' }

/* 视图模型里两格安装状态的键。两条流程按它分账世代号，也按它发布状态。 */
type InstallFlowKey = 'install' | 'skillInstall'

export interface PluginStore {
  readonly getSnapshot: () => PluginsViewModel
  readonly subscribe: (listener: () => void) => () => void
  /**
   * 读账本、读技能目录、读环境、取市场目录，然后投一次屏幕。
   *
   * 交回首扫的落定：账本、技能目录与 mcp.json 读完并投屏之时。MCP 名册在开会话那一刻
   * 被采样、此后不再重挂，所以开会话的人要先等到它 —— 而市场目录是网络往返，不在这份
   * 落定里：开一条对话不该等一次 CDN。
   *
   * 重复调用是幂等的，交回同一份落定。
   */
  readonly start: () => Promise<void>
  /** 让下一次 start() 重新首扫。谁 start 谁 stop。 */
  readonly stop: () => void
  readonly setEnabled: (pluginId: string, enabled: boolean) => void
  /**
   * 拨动一台服务器。
   *
   * 收的是来源而不是插件号：mcp.json 里那些不属于任何插件，硬塞进账本就得给它们编一个
   * 假的插件号，而那个号会出现在 agent 的 installed.json 里。开关落在哪份真相里由来源
   * 说了算：插件在账本里，mcp.json 里那些落回文件本身的 enabled 那一格 —— 与 CLI 拨的
   * 是同一格。
   */
  readonly setMcpServerEnabled: (
    target: ContributionOrigin,
    server: string,
    enabled: boolean,
  ) => void
  /**
   * 把一台服务器写进这个 agent 的 mcp.json —— 内置名单的一键安装。条目正文由调用方
   * 给：名单知道每台的形状与钥匙落在哪一格，这里只管读—改—写那一趟。同名条目会被
   * 整个换掉，所以「重装」与「改配置再装」是同一个动作。
   */
  readonly installEnvironmentServer: (name: string, body: Record<string, unknown>) => void
  /** 从 mcp.json 里删掉一台。名单上有它的卡片会拨回「可安装」，随时装得回来。 */
  readonly removeEnvironmentServer: (name: string) => void
  /**
   * 本进程托管的那台服务器在 mcp.json 里的条目，对齐到当前地址；body 缺席就拆掉条目。
   *
   * 端口每次启动由内核分配，所以这一趟每次启动都要跑。它与界面上的增删改走同一条队列、
   * 同一条读—改—写：mcp.json 只有一个写者，两边因此不会互相抹掉。
   */
  readonly reconcileHostedServer: (name: string, body: Record<string, unknown> | null) => void
  readonly remove: (pluginId: string) => void
  /**
   * 开始一次安装：下载、解压到暂存区。
   *
   * 收的是解好的结构不是字符串 —— 目录卡片手里已经有结构了，渲染成字符串再解析
   * 回来会丢掉子目录（网页地址里没有无歧义的写法）。输入框那条路自己先解析。
   */
  readonly beginInstall: (source: PluginInstallSource) => void
  readonly confirmInstall: () => void
  readonly cancelInstall: () => void
  /** 放弃在途的技能安装。技能没有确认步，所以这里只有「不要了」一个语义。 */
  readonly cancelSkillInstall: () => void
  readonly refreshMarketplace: () => void
  /**
   * 装一个技能：取件、解压、按前言取名、落进 skills/<name>/。一键到底，无确认步 ——
   * 技能是提示词文本，不带可执行面，风险档比插件低一级。
   */
  readonly installSkill: (source: PluginInstallSource) => void
  /** 卸载：删掉 skills/<name>/。名单上有它的卡片会拨回「可安装」。 */
  readonly removeInstalledSkill: (name: string) => void
}

export interface PluginStoreOptions {
  /**
   * 市场目录在哪。
   *
   * 官方默认值是 CDN 上那一份（上游 apps/kimi-code/src/constant/app.ts 的
   * KIMI_CODE_PLUGIN_MARKETPLACE_URL），不是仓库里那份源码检出兜底 —— 后者由上游
   * getSourceCheckoutMarketplaceLocation 提供，只在没配来源且 CDN 取失败时才用。
   *
   * 相对来源相对的就是这个地址，所以这里换一个地址，条目跟着换一个仓库，不需要在
   * 第二处配一遍。
   */
  readonly marketplaceUrl: string
  /** 领域层不摸时钟，时钟从这里交进去。测试因此不需要冻结全局时间。 */
  readonly now: () => string
  /** 全局命令面板：斜杠菜单的候选表。可选，缺席时斜杠菜单为空。 */
  readonly palette?: AgentPalettePort | undefined
}

/*
 * 账本里的一条，解码之后的样子。
 *
 * 开关与清单在同一条记录里，所以拨一个开关不需要回头重读清单：写成之后就地改这一条的
 * enabled 再发布。VS Code 切 enablement 不触发 extension scan，Obsidian 的
 * enabledPlugins 不触发 manifest 扫描，理由就是这个。
 */
interface ScannedPlugin {
  readonly pluginId: string
  readonly manifest: PluginManifest
  readonly diagnostics: readonly PluginDiagnostic[]
  /** 清单读不出来的记录仍然装着，但它不受那个开关支配。 */
  readonly readable: boolean
  readonly enabled: boolean
  readonly installedAt: string | undefined
  /** 人当初给的那一串地址；拿它回目录里查背书。 */
  readonly originalSource: string | undefined
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
  const listeners = new Set<() => void>()

  let scanned: readonly ScannedPlugin[] = []
  /* 这个 agent 自己那份 mcp.json 里的服务器。读不出来就是空。 */
  let environment: readonly DeclaredMcpServer[] = []
  /* 另一本账里的那些。读不出来就是空 —— 那只意味着这句话说不出来，不意味着装了什么。 */
  let foreignRecords: readonly ForeignPlugin[] = []
  /* 名单是什么时候取回来的，落在盘上：它替 marketplace 回答「算不算从来没取过」。 */
  const cache = createSnapshotCache()

  let snapshot: PluginsViewModel = {
    plugins: [],
    mcpServers: [],
    foreign: [],
    marketplace: MARKETPLACE_ABSENT,
    install: INSTALL_IDLE,
    skills: [],
    skillInstall: INSTALL_IDLE,
    loaded: false,
    palette: [],
  }

  /*
   * 这个 store 的状态迁移串行走一条队列。
   *
   * 连着拨两个开关会开出两次读—改—写；并发跑的话后写的那次带着更旧的账本，第一个
   * 开关就被悄悄拨回去了。链成一条队列，每次都在上一次落定之后才动。启动那一趟也在
   * 这条队列上：它读完账本要投一次屏幕，不能与一次拨动交错。
   */
  let queue: Promise<void> = Promise.resolve()

  /* 首扫的落定。开发期的挂载—卸载—再挂载会让 start() 被调用两次：交回同一份。 */
  let ready: Promise<void> | null = null

  /*
   * 两条安装流程各自的世代号。
   *
   * 取消只改得了屏幕上的状态，改不了已经飞出去的那一趟取件。带上世代号，落定的结果自己
   * 就能回答「我还是不是当前这一次」。号按流程分账：共用一个计数器时，开始装一个技能会
   * 让在途的插件安装在落定时判定自己已过期，而它那一格再没有人拨回去。
   */
  const epochs = { install: 0, skillInstall: 0 }

  /* 受控 home 的 skills/ 目录里装着的。目录即账本，这里是投影。 */
  let installedSkills: readonly InstalledSkill[] = []

  /*
   * 收下 agent 报来的命令表。
   *
   * 空表不写进屏幕：会话建起来之前报来的就是空表，而 AgentPalettePort 只有 read 与
   * subscribe，没有会话存活信号，「还没建会话」与「真的一个命令都没有」在这条端口上分不
   * 开。取保守的那一侧 —— 让上一次的结果留着，好过让人看见技能全没了。
   */
  function adoptPalette(): void {
    const palette = options.palette

    if (palette === undefined) {
      return
    }

    const entries = palette.read()

    if (entries.length === 0) {
      return
    }

    publish({ palette: entries })
    cache.write(options.now())
  }

  /*
   * 命令表的订阅。寿命是这个 store 的寿命，不是屏幕上有没有人在看。
   *
   * agent 推来的表问不回来（AgentPalettePort 只有 read 与 subscribe）。挂在订阅者计数
   * 上，没打开扩展页时那一次推送就落在地上，之后打开只剩缓存里那份旧表。
   */
  let stopPalette: (() => void) | null = null

  function publish(next: Partial<PluginsViewModel>): void {
    snapshot = { ...snapshot, ...next }

    for (const listener of listeners) {
      listener()
    }
  }

  /*
   * 背书来自目录，不来自安装动作本身。
   *
   * 比的是描述串：目录条目里的来源和账本里记下的那一串是两个结构相同、引用不同的
   * 东西，用 === 比永远不等，所有插件都会掉进 third-party。
   */
  function listing(described: string | undefined) {
    if (described === undefined) {
      return undefined
    }

    return latestCatalog(snapshot.marketplace)?.entries.find(
      (entry) => describeInstallSource(entry.source) === described,
    )
  }

  /*
   * 账本 + 清单，投成屏幕上那一份。这一步没有 I/O。
   *
   * 走到这里就意味着账本已经读过一遍，所以 loaded 恒真。
   */
  function republish(): void {
    const plugins: readonly InstalledPlugin[] = scanned.map((entry) => {
      const listed = listing(entry.originalSource)

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
      skills: installedSkills,
      loaded: true,
      palette: snapshot.palette,
    })
  }

  /*
   * 解一条记录：账本里那几格，加上清单原文解出来的形状。
   *
   * 没有 I/O。清单原文由原生侧在列举时一并交过来，所以全部开销就是一次 JSON 解析加一次
   * schema 校验 —— 此前这里每个插件要为每条声明路径再走一趟原生读目录，而读出来的技能
   * 与命令没有第二个读者：装载它们的是 CLI。
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
      originalSource: payload.originalSource ?? undefined,
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
   * 这个 agent 自己那份 mcp.json 里已经配好的服务器。
   *
   * 不是「这台机器上的所有 MCP」：Cursor、Claude Desktop、Windsurf 各有各的配置文件，
   * 这个 agent 一个都不读，列出来只会得到一排拨了不生效的开关。哪一份算数由原生侧
   * 的 agent_home_directory 说了算，这里不猜路径。
   */
  async function readEnvironment(): Promise<void> {
    const file = await readEnvironmentMcpConfig()

    if (file.contents === null) {
      environment = []

      return
    }

    const decoded = decodeMcpConfig(
      { kind: 'user', location: file.location },
      JSON.parse(file.contents),
    )

    if (decoded.malformed) {
      warn('这个 agent 的 mcp.json 不是预期的形状', {
        scope: 'plugins',
        location: file.location,
      })
    }

    environment = decoded.servers
  }

  /* 装了什么，agent 的账本说了算。开关与清单在同一条记录里，一次读齐。 */
  async function rescan(): Promise<void> {
    const payloads = await listPlugins()

    scanned = payloads.map(scan)
  }

  /* 技能装了什么，skills/ 目录说了算：一个含 SKILL.md 的子目录是一个技能。 */
  async function rescanSkills(): Promise<void> {
    const payloads = await listSkills()

    installedSkills = payloads.map(decodeSkillPayload)
  }

  /*
   * 另一本账 —— 用户自己那个家里的那一份。只读。
   *
   * 读它不是为了把它算进「装了什么」：受控 home 生效时，我们开出去的会话只装载受控
   * home 那本账，所以这一份里的插件在这里确实没有装上，目录卡片写「可安装」是真话。
   * 假的是屏幕对此一言不发。
   *
   * null 表示这台机器上没有第二本账（受控 home 没有生效，两边读同一个文件）。
   */
  async function readForeign(): Promise<void> {
    const ledger = await listForeignPlugins()

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
   * 写成了才发布。失败不动屏幕：人看到的仍然是账本里那一份。
   *
   * 每一次改动都是「先写 agent 会读的那个文件，再改屏幕」，没有第三种顺序。
   */
  function commit(what: string, write: () => Promise<void>, after: () => void): void {
    queue = queue.then(async () => {
      try {
        await write()
      } catch (cause: unknown) {
        warn(what, { scope: 'plugins', cause })

        return
      }

      after()
    })
  }

  /*
   * mcp.json 的一次读—改—写。原文连同改好的正文一起交给原生侧（写入命令先比对再
   * 落盘）：这条队列已经把本进程内的改写串成一串，比对挡的是进程外的写者 —— 终端里
   * 的 CLI 或人手改。写成之后就地重读再投影，屏幕上那份永远来自文件。
   */
  function rewriteEnvironment(what: string, transform: (contents: string | null) => string): void {
    commit(
      what,
      async () => {
        const file = await readEnvironmentMcpConfig()

        await writeEnvironmentMcpConfig(file.contents, transform(file.contents))
        await readEnvironment()
      },
      republish,
    )
  }

  function trustOf(source: PluginInstallSource): PluginTrustTier {
    return listing(describeInstallSource(source))?.trust ?? UNLISTED_TRUST
  }

  /*
   * 启动时那几趟只读取用。
   *
   * 一趟坏了不该让另外几趟的结果也进不了屏幕，所以失败在这里落地；「读不出来算什么」
   * 只有调用方知道，兜底值因此由它给。
   */
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
      const contents = await readPluginCatalog()

      if (contents === null) {
        return
      }

      publish({
        marketplace: completeFetch(
          snapshot.marketplace,
          JSON.parse(contents),
          cache.read().catalogFetchedAt,
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
      const contents = await refreshPluginCatalog(options.marketplaceUrl)

      publish({
        marketplace: completeFetch(
          snapshot.marketplace,
          JSON.parse(contents),
          options.now(),
          options.marketplaceUrl,
        ),
      })
    } catch (cause: unknown) {
      publish({
        marketplace: failFetch(
          snapshot.marketplace,
          cause instanceof Error ? cause.message : String(cause),
        ),
      })
    }
  }

  function publishFlow(flow: InstallFlowKey, state: InstallFlow): void {
    publish(flow === 'install' ? { install: state } : { skillInstall: state })
  }

  function refuse(flow: InstallFlowKey, cause: unknown): void {
    publishFlow(flow, {
      kind: 'refused',
      reason: cause instanceof Error ? cause.message : String(cause),
    })
  }

  /*
   * 取件—暂存—认领这一趟，两条流程同一条代码路径。
   *
   * 差别只有三样：状态落在哪一格、怎么暂存、暂存件到手之后做什么。它们是参数，不是第二
   * 份实现 —— 此前各写一遍，于是「过期就丢掉」那一支在技能那边漏了一半。
   *
   * 过期分支不发布：每一次世代号推进都有主人，取消那一路自己发过空闲，被顶掉的那一路
   * 由顶掉它的那一次发过 staging。这里再发一次只会把新的那一格抹掉。
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
      publishFlow(flow, { kind: 'refused', reason: planning.reason })

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
        refuse(flow, cause)

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
        refuse(flow, cause)
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

    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },

    start() {
      if (ready !== null) {
        return ready
      }

      if (options.palette !== undefined) {
        stopPalette = options.palette.subscribe(adoptPalette)

        /* 接上之前 agent 可能已经报过一份：会话可能比这一趟启动更早建好。 */
        adoptPalette()
      }

      queue = queue.then(async () => {
        /*
         * 五趟互不依赖，一起等而不是排成五趟：每一趟都只读，写的只是各自那个模块级
         * 变量，所以并发跑不会互相盖。首屏因此是一趟往返的时间，不是五趟。
         */
        await Promise.all([
          guard('插件列表读取失败', rescan, () => {
            scanned = []
          }),
          guard('技能目录读不出来', rescanSkills, () => {
            installedSkills = []
          }),
          guard('命令行上那本插件账读不出来', readForeign, () => {
            foreignRecords = []
          }),
          guard('这个 agent 的 mcp.json 读不出来', readEnvironment, () => {
            environment = []
          }),
          loadCatalog(),
        ])

        /*
         * 本地真相先上屏。MCP 名册与已装清单只依赖上面那六趟，而名册在开会话那一刻
         * 被采样、此后不再重挂 —— 它的就绪不能排在一次网络往返之后。
         */
        republish()
      })

      ready = queue

      queue = queue.then(async () => {
        /*
         * 只有从来没取过才自动拉一次，这条判据由 shouldFetchOnOpen 一个地方说了算，
         * 而它要等 loadCatalog 落定才问得出来。背书是拿账本里的 originalSource 回目录
         * 里查出来的，目录到了要再投一次 —— 但开一条对话不等这一趟网络。
         */
        if (shouldFetchOnOpen(snapshot.marketplace)) {
          await fetchCatalog()

          republish()
        }

        cache.write(latestCatalog(snapshot.marketplace)?.fetchedAt ?? '')
      })

      return ready
    },

    stop() {
      ready = null
      stopPalette?.()
    },

    setEnabled(pluginId, enabled) {
      commit(
        '插件开关没能写进 agent 的账本，屏幕上仍是账本里那一份',
        () => setPluginEnabled(pluginId, enabled),
        () => {
          /* 就地改这一条，不回头重读账本：清单一个字节没动，重扫一遍是白扫。 */
          scanned = scanned.map((entry) =>
            entry.pluginId === pluginId ? { ...entry, enabled } : entry,
          )

          republish()
        },
      )
    },

    setMcpServerEnabled(target, server, enabled) {
      if (target.kind === 'user') {
        rewriteEnvironment('MCP 服务器的开关没能写进 mcp.json，屏幕上仍是文件里那一份', (raw) =>
          setMcpServerEnabledInConfig(raw, server, enabled),
        )

        return
      }

      const { pluginId } = target

      commit(
        'MCP 服务器的开关没能写进 agent 的账本，屏幕上仍是账本里那一份',
        () => setPluginMcpEnabled(pluginId, server, enabled),
        () => {
          scanned = scanned.map((entry) =>
            entry.pluginId === pluginId
              ? {
                  ...entry,
                  disabledMcpServers: enabled
                    ? entry.disabledMcpServers.filter((name) => name !== server)
                    : [...entry.disabledMcpServers, server],
                }
              : entry,
          )

          republish()
        },
      )
    },

    installEnvironmentServer(name, body) {
      rewriteEnvironment('MCP 服务器没能写进 mcp.json，名单上那张卡片因此不动', (raw) =>
        upsertMcpServer(raw, name, body),
      )
    },

    removeEnvironmentServer(name) {
      rewriteEnvironment('MCP 服务器没能从 mcp.json 里删掉，界面因此不动', (raw) =>
        removeMcpServer(raw, name),
      )
    },

    reconcileHostedServer(name, body) {
      commit(
        '托管的那台 MCP 服务器的条目没能对上账',
        async () => {
          const file = await readEnvironmentMcpConfig()

          /* 保留人手写在这一条上的其余键：对账只负责地址那几格。 */
          const next =
            body === null
              ? removeMcpServer(file.contents, name)
              : upsertMcpServer(file.contents, name, {
                  ...mcpServerBodyInConfig(file.contents, name),
                  ...body,
                })

          if (next === file.contents) {
            return
          }

          await writeEnvironmentMcpConfig(file.contents, next)
          await readEnvironment()
        },
        republish,
      )
    },

    /*
     * 卸载 = 账本里那一条没了。
     *
     * 装载与不装载都由那份记录说了算，删记录就是卸载本身；托管副本由原生侧顺手清掉，
     * 那只是清垃圾，不是这件事的语义。
     */
    remove(pluginId) {
      commit(
        '插件没能从 agent 的账本里删掉，界面因此不动',
        async () => {
          await removePlugin(pluginId)
          await rescan()
        },
        republish,
      )
    },

    beginInstall(source) {
      beginStagedInstall(
        'install',
        source,
        stagePlugin,
        discardStagedPlugin,
        async (staged, subdirectory) => {
          /* 诊断带上暂存号：插件号这一刻还不知道，而空串溯不回任何东西。 */
          const decoded = decodeManifestJson(staged.stagingId, staged.manifestJson)

          if (decoded.kind === 'rejected') {
            await discardStagedPlugin(staged.stagingId)
            publishFlow('install', {
              kind: 'refused',
              reason: decoded.diagnostics.map((entry) => entry.detail).join('; '),
            })

            return
          }

          const trust = trustOf(source)

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
          await discardStagedPlugin(install.stagingId)
        } catch (cause: unknown) {
          warn('暂存目录没能清掉', { scope: 'plugins', cause })
        }
      })
    },

    installSkill(source) {
      beginStagedInstall(
        'skillInstall',
        source,
        stageSkill,
        discardStagedSkill,
        async (staged, subdirectory) => {
          /* 名字取自前言，缺席回落到子目录名。原生侧落盘前还会验一遍安全性。 */
          const fallback = subdirectory?.split('/').pop() ?? 'skill'
          const name = parseSkillFrontmatter(staged.skillMd).name || fallback

          await commitSkill({ stagingId: staged.stagingId, name, subdirectory })

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

    removeInstalledSkill(name) {
      commit(
        '技能没能从目录里删掉，界面因此不动',
        async () => {
          await removeSkill(name)
          await rescanSkills()
        },
        republish,
      )
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
   * 认领：副本进 managed/<id>/，账本里多一条。两件事在原生侧一次做完，因为它们中间
   * 断开就会留下一条指向空气的记录，而 agent 会照着它去装载。
   *
   * 时刻从 options.now() 走。原生侧没有理由持有第二个时间源。
   */
  function adopt(
    stagingId: string,
    pluginId: string,
    source: PluginInstallSource,
    subdirectory: string | null,
  ): void {
    queue = queue.then(async () => {
      try {
        await commitPlugin({
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
            reason: cause instanceof Error ? cause.message : String(cause),
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
    })
  }
}

/*
 * 清单读不出来的记录仍然是一个装着的插件：它得在界面上占一行，好让人看见原因。
 * 把它从列表里抹掉，人只会看到「我明明装了它却不见了」。
 */
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

function decodeManifestJson(pluginId: string, contents: string) {
  try {
    return decodePluginManifest(JSON.parse(contents))
  } catch (cause: unknown) {
    const diagnostics: PluginDiagnostic[] = [
      {
        code: 'manifest-invalid',
        pluginId,
        detail: cause instanceof Error ? cause.message : String(cause),
      },
    ]

    return { kind: 'rejected' as const, diagnostics }
  }
}
