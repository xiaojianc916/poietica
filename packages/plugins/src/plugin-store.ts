import type { AgentPalettePort, PaletteEntry } from '@poietica/agent-contract'
import { assertUnreachable, createPreference, warn } from '@poietica/core'
import {
  commitPlugin,
  discardStagedPlugin,
  listForeignPlugins,
  listPlugins,
  readEnvironmentMcpConfig,
  readMcpEndpoint,
  readPluginCatalog,
  refreshPluginCatalog,
  removePlugin,
  setPluginEnabled,
  setPluginMcpEnabled,
  stagePlugin,
} from '@poietica/ipc'
import { planFetch } from './fetch-plan'
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
import { type DeclaredMcpServer, decodeMcpConfig } from './mcp-config'
import { type BuiltinMcpServer, type ResolvedMcpServer, resolveMcpServers } from './mcp-servers'
import type { ManagedOrigin } from './origin'
import { createSnapshotCache } from './registry/snapshot'

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
   * 对话里敲得出来的那些命令，agent 报来的整张表。
   *
   * 技能那一格读的就是它。技能只有 agent 说得出来 —— 全局装的、它自己带的、插件带来
   * 的都算，而这三样只有装载它们的那一侧看得见。本应用不扫盘：扫出来的那份永远只是
   * 其中一部分，两份清单并存就一定有一天对不上。
   */
  readonly palette: readonly PaletteEntry[]
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
   * 探测完成的时刻。空串表示屏幕上这一份还是快照，真相没到。
   *
   * 它必须露在界面上：一个从缓存里画出来的列表和一个刚探测完的列表长得一模一样，没有这
   * 一格，人无从判断自己看的是不是旧的。
   */
  readonly detectedAt: string
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

export interface PluginStore {
  readonly getSnapshot: () => PluginsViewModel
  readonly subscribe: (listener: () => void) => () => void
  /**
   * 读账本、读环境、问内置那台的地址、取市场目录，然后投一次屏幕。
   *
   * 不返回停表函数：订阅归 subscribe 所有，start 一个也没建，所以它没有东西可停。交回
   * 一个 listeners.clear() 会把别人的订阅一并清掉，而 React 在开发期必然会挂载—卸载—
   * 再挂载一次。重复调用是幂等的。
   */
  readonly start: () => void
  readonly setEnabled: (pluginId: string, enabled: boolean) => void
  /**
   * 拨动一台服务器。
   *
   * 收的是来源而不是插件号：内置那台不属于任何插件，硬塞进账本就得给它编一个假的
   * 插件号，而那个号会出现在 agent 的 installed.json 里。机器上那些根本不在
   * ManagedOrigin 里，所以「它们改不了」由编译器说，不靠调用方自觉。
   */
  readonly setMcpServerEnabled: (target: ManagedOrigin, server: string, enabled: boolean) => void
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
  readonly refreshMarketplace: () => void
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
  /**
   * 命令表从哪来。
   *
   * 领域层不认识 IPC，也不该认识：这条端口由组合根交进来，所以这个 store 在
   * Node 里可以脱离进程与界面单独测。
   */
  readonly palette: AgentPalettePort
  /** 领域层不摸时钟，时钟从这里交进去。测试因此不需要冻结全局时间。 */
  readonly now: () => string
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

/*
 * 本进程自带的那台服务器叫什么。
 *
 * 名字要稳定且与界面语言无关：它会作为工具名的前缀出现在会话里，跟着界面语言变，
 * 同一段对话历史里的工具名就会前后对不上。
 */
const BUILTIN_SERVER_NAME = 'poietica-automations'

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

  /*
   * 内置那台的开关。
   *
   * 它不进 agent 的账本：那份文件的形状是「按插件号索引的一张表」，塞一个不存在的
   * 插件进去，对方的卸载与重载会开始处理一个永远不会被卸载的东西。
   *
   * 走 createPreference 是因为它必须在第一帧就有答案 —— 异步的设置管线会让这一行
   * 先画成关的再跳成开的。默认开着，所以只有「关掉」需要落盘。
   */
  const builtinEnabled = createPreference<boolean>({
    key: 'poietica.mcp.builtin.enabled',
    fallback: true,
    decode: (raw) => raw !== 'false',
    encode: (value) => (value ? null : 'false'),
    onFailure: (failure) => {
      warn('内置 MCP 服务器的开关没能存下来', { scope: 'plugins', ...failure })
    },
  })

  let scanned: readonly ScannedPlugin[] = []
  /* 这个 agent 自己那份 mcp.json 里的服务器。读不出来就是空。 */
  let environment: readonly DeclaredMcpServer[] = []
  /* 另一本账里的那些。读不出来就是空 —— 那只意味着这句话说不出来，不意味着装了什么。 */
  let foreignRecords: readonly ForeignPlugin[] = []
  /* 原生侧登记的那个地址。绑不上端口时缺席，那一行照样显示并说明原因。 */
  let builtinUrl: string | undefined
  /*
   * 上一次探测落在盘上的那一份。
   *
   * 只存命令表：账本与 mcp.json 一趟本地读就回来了，把它们也塞进快照等于造第二份降级的
   * 真相；真正会长时间为空的是命令表 —— 它由 agent 在会话建立后报来，会话没建之前那一格
   * 恒空，人看到的是「我的技能全没了」。
   *
   * 它只回答「真相到达之前先画什么」，从不参与任何判定：装了什么永远由账本说了算。
   */
  const cache = createSnapshotCache({ now: options.now })

  const restored = cache.read()

  let snapshot: PluginsViewModel = {
    plugins: [],
    mcpServers: [],
    palette: restored.palette,
    foreign: [],
    marketplace: MARKETPLACE_ABSENT,
    install: INSTALL_IDLE,
    detectedAt: restored.detectedAt,
    loaded: false,
  }

  /*
   * 这个 store 的状态迁移串行走一条队列。
   *
   * 连着拨两个开关会开出两次读—改—写；并发跑的话后写的那次带着更旧的账本，第一个
   * 开关就被悄悄拨回去了。链成一条队列，每次都在上一次落定之后才动。启动那一趟也在
   * 这条队列上：它读完账本要投一次屏幕，不能与一次拨动交错。
   */
  let queue: Promise<void> = Promise.resolve()

  /* 开发期的挂载—卸载—再挂载会让 start() 被调用两次。第二次什么也不做。 */
  let started = false

  /*
   * 安装的世代号。
   *
   * 取消只改得了屏幕上的状态，改不了已经飞出去的那一趟取件。带上世代号，落定的结果自己
   * 就能回答「我还是不是当前这一次」—— 不是就丢掉，而不是把确认框又拽回来。
   */
  let installEpoch = 0

  /*
   * 收下 agent 报来的命令表。
   *
   * 空表不写进屏幕：会话建起来之前报来的就是空表，而 AgentPalettePort 只有 read 与
   * subscribe，没有会话存活信号，「还没建会话」与「真的一个命令都没有」在这条端口上分不
   * 开。取保守的那一侧 —— 让上一次的结果留着，好过让人看见技能全没了。
   */
  function adoptPalette(): void {
    const entries = options.palette.read()

    if (entries.length === 0) {
      return
    }

    publish({ palette: entries, detectedAt: options.now() })
    cache.write(entries, cache.read().catalogFetchedAt)
  }

  /*
   * 命令表的订阅。
   *
   * 它不挂在 start() 上：那个方法幂等、也不交回停表函数（见它自己的文档），挂上去
   * 就没有地方收。归 subscribe 所有，与 listeners 同一个寿命。
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
      mcpServers: resolveMcpServers({ builtin: builtinServers(), environment, plugins }),
      /* 两边都装着的不算「别处装过」：那一条已经在上面的 plugins 里了。 */
      foreign: foreignRecords.filter((record) => !here.has(record.pluginId)),
      loaded: true,
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

  /*
   * 原生侧那台服务器的地址。
   *
   * 它在应用启动时就绑好了（apps/desktop/src-tauri/src/mcp.rs 的 serve），这里只问
   * 一次 —— 端口由内核分配，两边都不需要事先约定一个数字。绑不上时交回 null。
   */
  async function readBuiltinEndpoint(): Promise<void> {
    builtinUrl = (await readMcpEndpoint())?.url
  }

  /*
   * 内置那台永远在列表里，哪怕地址没问到。
   *
   * 起不来就不显示，人看到的是「它凭空消失了」；显示出来并写明原因，人才知道该去看
   * 端口还是去看日志。与「关掉的插件照样列出来」同一条理由。
   */
  function builtinServers(): readonly BuiltinMcpServer[] {
    return [{ name: BUILTIN_SERVER_NAME, url: builtinUrl, enabled: builtinEnabled.read() }]
  }

  /* 装了什么，agent 的账本说了算。开关与清单在同一条记录里，一次读齐。 */
  async function rescan(): Promise<void> {
    const payloads = await listPlugins()

    scanned = payloads.map(scan)
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

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)

      /*
       * 第一个订阅者来时接上命令表，最后一个走时收掉。这条通道有一个真的要收的
       * 东西，所以它的家在这里而不是 start() 里 —— 后者收不了。
       */
      if (stopPalette === null) {
        stopPalette = options.palette.subscribe(adoptPalette)

        /* 接上之前 agent 可能已经报过一份：会话在插件页打开之前就建好了。 */
        adoptPalette()
      }

      return () => {
        listeners.delete(listener)

        if (listeners.size > 0) {
          return
        }

        stopPalette?.()
        stopPalette = null
      }
    },

    start() {
      if (started) {
        return
      }

      started = true

      queue = queue.then(async () => {
        /*
         * 五趟互不依赖，一起等而不是排成五趟：每一趟都只读，写的只是各自那个模块级
         * 变量，所以并发跑不会互相盖。首屏因此是一趟往返的时间，不是五趟。
         */
        await Promise.all([
          guard('插件列表读取失败', rescan, () => {
            scanned = []
          }),
          guard('命令行上那本插件账读不出来', readForeign, () => {
            foreignRecords = []
          }),
          guard('这个 agent 的 mcp.json 读不出来', readEnvironment, () => {
            environment = []
          }),
          guard('内置 MCP 服务器的地址问不出来', readBuiltinEndpoint, () => {
            builtinUrl = undefined
          }),
          loadCatalog(),
        ])

        /*
         * 只有从来没取过才自动拉一次，这条判据由 shouldFetchOnOpen 一个地方说了算，
         * 而它要等 loadCatalog 落定才问得出来。
         *
         * 这里必须 await：背书是拿账本里的 originalSource 回目录里查出来的，目录没到
         * 时每一条都只能是「没有背书」，所以最后那次 republish 必须排在目录之后。
         */
        if (shouldFetchOnOpen(snapshot.marketplace)) {
          await fetchCatalog()
        }

        /*
         * 探测完成的时刻只在这里落一次，不写在 republish 里 —— 后者每拨一个开关都会走一
         * 遍，写在那儿会让「上次检测」在拨开关时无缘无故往前跳。
         */
        publish({ detectedAt: options.now() })
        republish()
        cache.write(snapshot.palette, latestCatalog(snapshot.marketplace)?.fetchedAt ?? '')
      })
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
      if (target.kind === 'builtin') {
        /*
         * 内置那一台的开关落在偏好里，插件那一台落在账本里，可它们在屏幕上是同一个控件。
         * 两条写入必须走同一条队列，否则连拨两下的落点顺序由调度决定。
         */
        queue = queue.then(() => {
          builtinEnabled.write(enabled)
          republish()
        })

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
      const planning = planFetch(source)

      if (planning.kind === 'unplannable') {
        publish({ install: { kind: 'refused', reason: planning.reason } })

        return
      }

      const epoch = ++installEpoch

      publish({ install: { kind: 'staging', source } })

      const subdirectory = planning.plan.kind === 'archive' ? planning.plan.subdirectory : null

      queue = queue.then(async () => {
        try {
          const staged = await stagePlugin(planning.plan)

          /*
           * 取件途中人按了取消、或者又发起了下一次：这一趟的结果已经没人要了。丢掉它并把
           * 暂存目录清掉 —— 不看世代号就直接发布，确认框会在人取消之后自己弹回来。
           */
          if (epoch !== installEpoch) {
            await discardStagedPlugin(staged.stagingId)

            return
          }

          const decoded = decodeManifestJson('', staged.manifestJson)

          if (decoded.kind === 'rejected') {
            await discardStagedPlugin(staged.stagingId)
            publish({
              install: {
                kind: 'refused',
                reason: decoded.diagnostics.map((entry) => entry.detail).join('; '),
              },
            })

            return
          }

          const trust = trustOf(source)

          publish({
            install: {
              kind: 'staged',
              stagingId: staged.stagingId,
              source,
              subdirectory,
              manifest: decoded.manifest,
              diagnostics: decoded.diagnostics,
              trust,
            },
          })

          /* 官方来源不拦；其余一律等人点头，这条判据只有 install-source 说了算。 */
          if (!requiresInstallConfirmation(trust)) {
            adopt(staged.stagingId, decoded.manifest.name, source, subdirectory)
          }
        } catch (cause: unknown) {
          publish({
            install: {
              kind: 'refused',
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          })
        }
      })
    },

    confirmInstall() {
      const { install } = snapshot

      if (install.kind !== 'staged') {
        return
      }

      adopt(install.stagingId, install.manifest.name, install.source, install.subdirectory)
    },

    cancelInstall() {
      const { install } = snapshot

      /* 往前一格：还在路上的那一趟落定时会看见自己已经过期，于是自行丢弃。 */
      installEpoch += 1

      publish({ install: INSTALL_IDLE })

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
