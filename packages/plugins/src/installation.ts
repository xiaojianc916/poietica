import type { PluginInstallSource, PluginTrustTier } from './install-source'
import type { PluginDiagnostic, PluginManifest } from './manifest'

/*
 * 一个装好的插件 = agent 的 installed.json 里的一条记录，加上那条记录指向的清单。
 *
 * 「装了什么」的真相在 agent 家里那份账本，不在任何一个我们自己维护的地方。
 *
 * source 与 trust 不落盘。官方记录里只有 originalSource 这一串地址，背书是我们的
 * 概念 —— 读的时候拿它回目录里查，查不到就是没有背书。往人家的契约里塞我们的字段，
 * 换来的只有一份迟早被对方的写入抹掉的数据。
 *
 * 清单之外什么都不带。技能、命令、提示词是 CLI 在装载时自己读的东西 —— 官方 plugins
 * 文档里 skills 与 commands 是路径、systemPrompt 由运行时注入，我们再读一遍只会得到
 * 一份没人用的副本，而且它看不见全局技能。这里只留「账本记了什么、清单声明了什么」。
 */
export interface InstalledPlugin {
  /**
   * 官方记录里的 id。
   *
   * 它由上游的 normalizePluginId(manifest.name) 得出，而 name 的正则
   * `[a-z0-9][a-z0-9_-]{0,63}` 本来就只允许小写，所以它与清单里的 name 恒等 ——
   * 「目录名与清单名可能分叉」在这一版里不再是一种可能，因为身份不再来自目录名。
   */
  readonly pluginId: string
  readonly manifest: PluginManifest
  /** 能在目录里查到这条来源时才有。查不到不代表没装，只代表没有背书。 */
  readonly source: PluginInstallSource | undefined
  readonly trust: PluginTrustTier
  readonly enabled: boolean
  /* ISO-8601。装载顺序按它排。 */
  readonly installedAt: string | undefined
  /* 插件整体启用、但被单独关掉的那几台 MCP 服务器。 */
  readonly disabledMcpServers: readonly string[]
  readonly diagnostics: readonly PluginDiagnostic[]
}

/*
 * 解析顺序：安装时间升序，同刻按 id 升序，时间未知的排在最前。
 *
 * 这个顺序必须是全序且稳定：屏幕上那张 MCP 列表按它排，不稳定就会在两次启动之间
 * 自己换位置。id 在账本里天然唯一，所以同刻那一档也是全序。
 */
export function resolutionOrder(plugins: readonly InstalledPlugin[]): readonly InstalledPlugin[] {
  return [...plugins].sort((left, right) => {
    const leftAt = left.installedAt ?? ''
    const rightAt = right.installedAt ?? ''

    if (leftAt !== rightAt) {
      return leftAt < rightAt ? -1 : 1
    }

    if (left.pluginId === right.pluginId) {
      return 0
    }

    return left.pluginId < right.pluginId ? -1 : 1
  })
}
