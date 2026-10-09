import {
  clearPluginRootsAndCaches,
  resolveOrDefaultProjectRegistryPath,
} from '@oh-my-pi/pi-coding-agent/discovery/helpers'
import { PluginManager } from '@oh-my-pi/pi-coding-agent/extensibility/plugins'
import {
  getInstalledPluginsRegistryPath,
  getMarketplacesCacheDir,
  getMarketplacesRegistryPath,
  getPluginsCacheDir,
  MarketplaceManager,
} from '@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace'
import type { MarketplaceEntry, PluginInfo, PluginsPort } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { z } from 'zod'
import { toEngineError } from '../errors'

/** PluginsPort 需要的东西：工作目录（项目级注册表按它解析）、logger。 */
export interface PluginsPortDeps {
  readonly cwd: string
  readonly logger: Logger
}

/**
 * 插件端口。用 omp 自己的插件管理器、安装器与市场（**市场源也是 omp 自己的**，不再用 legacy
 * 写死的那个地址）。安装失败的回滚交给 omp 的 installer，不再保留 legacy 的「暂存 / 提交 / 丢弃」。
 */
export class OmpPluginsPort implements PluginsPort {
  constructor(private readonly d: PluginsPortDeps) {}

  /** 已安装的插件：PluginManager 自己那份 lock 文件是唯一真相。 */
  async list(): Promise<z.infer<typeof PluginInfo>[]> {
    try {
      const installed = await this.#manager().list()
      return installed.map((plugin) => ({
        id: plugin.name,
        name: plugin.manifest.name ?? plugin.name,
        version: plugin.version,
        description: plugin.manifest.description ?? '',
        enabled: plugin.enabled,
        source: plugin.path,
      }))
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 市场目录：名字里有 query 就过滤（大小写不敏感），没有就整份列出。 */
  async marketplace(query: string | null): Promise<z.infer<typeof MarketplaceEntry>[]> {
    try {
      const manager = await this.#marketplace()
      const [available, installed] = await Promise.all([manager.listAvailablePlugins(), manager.listInstalledPlugins()])
      const owned = new Set(installed.map((row) => row.id))
      const needle = query === null ? null : query.trim().toLowerCase()
      return available
        .filter((entry) => needle === null || entry.name.toLowerCase().includes(needle))
        .map((entry) => ({
          id: entry.name,
          name: entry.name,
          version: entry.version ?? '',
          description: entry.description ?? '',
          installed: owned.has(entry.name),
        }))
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 装一个市场插件：id 形如 `name@marketplace`（omp 自己的 id 约定）。 */
  async install(id: string): Promise<z.infer<typeof PluginInfo>> {
    try {
      const parsed = id.indexOf('@')
      if (parsed <= 0) {
        throw new AppError(SystemErrorCode.invalidParams, `插件 id 必须是 name@marketplace：${id}`)
      }
      const name = id.slice(0, parsed)
      const marketplace = id.slice(parsed + 1)
      const manager = await this.#marketplace()
      await manager.installPlugin(name, marketplace)
      const installed = (await this.list()).find((plugin) => plugin.id === name)
      if (installed === undefined) {
        throw new AppError(SystemErrorCode.internal, `插件装完却不在清单里：${id}`)
      }
      return installed
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 卸载：市场插件与本地插件是同一条 lock 记录，这里两条路都试。 */
  async uninstall(id: string): Promise<void> {
    try {
      await this.#requireInstalled(id)
      const manager = await this.#marketplace()
      const owned = (await manager.listInstalledPlugins()).find((row) => row.id === id)
      if (owned !== undefined) {
        await manager.uninstallPlugin(id)
        return
      }
      await this.#manager().uninstall(id)
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    try {
      await this.#requireInstalled(id)
      const manager = await this.#marketplace()
      const owned = (await manager.listInstalledPlugins()).find((row) => row.id === id)
      if (owned !== undefined) {
        await manager.setPluginEnabled(id, enabled)
        return
      }
      await this.#manager().setEnabled(id, enabled)
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /**
   * 没装过的插件如实报错，不静默成功：omp 的 uninstall 转手给 `bun uninstall`，
   * 删一个不存在的包也返回 0 —— 把它当成功报出去，界面会显示「已卸载」而实际什么都没变。
   */
  async #requireInstalled(id: string): Promise<void> {
    const known = (await this.list()).some((plugin) => plugin.id === id)
    if (!known) throw new AppError(SystemErrorCode.notFound, `没有这个插件：${id}`)
  }

  /** omp 的插件管理器（本地插件与 lock 文件）。 */
  #manager(): PluginManager {
    return new PluginManager(this.d.cwd)
  }

  /** omp 的市场管理器：路径全部由它自己的 registry 给，不在这里拼。 */
  async #marketplace(): Promise<MarketplaceManager> {
    const projectInstalledRegistryPath = await resolveOrDefaultProjectRegistryPath(this.d.cwd)
    return new MarketplaceManager({
      marketplacesRegistryPath: getMarketplacesRegistryPath(),
      installedRegistryPath: getInstalledPluginsRegistryPath(),
      ...(projectInstalledRegistryPath === undefined ? {} : { projectInstalledRegistryPath }),
      marketplacesCacheDir: getMarketplacesCacheDir(),
      pluginsCacheDir: getPluginsCacheDir(),
      clearPluginRootsCache: clearPluginRootsAndCaches,
    })
  }
}
