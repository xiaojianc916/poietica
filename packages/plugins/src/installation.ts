import type { PluginInstallSource, PluginTrustTier } from './install-source'
import type { PluginDiagnostic, PluginManifest } from './manifest'
import type { PluginRegistry } from './registry'

/*
 * 一个装好的插件 = agent 的 installed.json 里的一条记录，加上那条记录指向的清单。
 *
 * 「装了什么」的真相在 agent 家里那份账本，不在任何一个我们自己维护的地方。
 *
 * source 与 trust 不落盘。官方记录里只有 originalSource 这一串地址，背书是我们的
 * 概念 —— 读的时候拿它回目录里查，查不到就是没有背书。往人家的契约里塞我们的字段，
 * 换来的只有一份迟早被对方的写入抹掉的数据。
 *
 * systemPromptText 是物化之后的正文：清单说的是提示词在哪（内联，或一条路径，
 * 或两者依次），预算算的是它有多少字节 —— 算不了一条还没读的路径。读文件是原生
 * 侧的事，读完落在这里，领域层因此不需要碰文件系统。
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
  readonly systemPromptText: string | undefined
  /*
   * 清单声明的那几条 ./ 路径，加上路径下那些 Markdown，物化出来的技能与命令。
   *
   * 与 systemPromptText 同一档：清单只说「到哪里找」，实体要读盘才知道，读完落在这里，
   * 领域层因此不需要碰文件系统。
   */
  readonly registry: PluginRegistry
  /* 插件整体启用、但被单独关掉的那几台 MCP 服务器。 */
  readonly disabledMcpServers: readonly string[]
  readonly diagnostics: readonly PluginDiagnostic[]
}

/*
 * 解析顺序：安装时间升序，同刻按 id 升序，时间未知的排在最前。
 *
 * 预算耗尽时被丢掉的是后来者，所以这个顺序必须是全序且稳定 —— 否则同一批插件
 * 两次启动会得到两套不同的提示词。id 在账本里天然唯一，所以同刻那一档也是全序。
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
