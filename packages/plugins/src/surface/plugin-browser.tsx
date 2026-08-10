import { Button } from '@poietica/ui'
import { useState } from 'react'

import { describeInstallSource, parseInstallSource } from '../install-source'
import type { InstalledPlugin } from '../installation'
import { latestCatalog, type MarketplaceEntry, type MarketplaceState } from '../marketplace'
import type { ForeignPlugin, InstallFlow, PluginStore } from '../plugin-store'
import { PluginGlyph } from './plugin-glyph'
import { TrustBadge } from './trust-badge'

/*
 * 目录页。
 *
 * 「装了什么」不在这里判 —— 传进来的 plugins 就是磁盘上那一份，这里只做减法：
 * 已经在盘上的条目不再出现在下面的目录网格里，而是升到上面那一行「已安装」。
 */

/*
 * 清单说得出的那几件事。
 *
 * 技能与命令的条数不在这里出现：读它们的是 CLI，本应用没有那份数字，硬要有就得自己
 * 再扫一遍盘 —— 而扫出来的那份看不见全局技能，与「技能」那一格永远对不上。
 */
function capabilitySummary(plugin: InstalledPlugin): string {
  const { commandRoots, mcpServerNames, promptSources, sessionStartSkill } = plugin.manifest

  const parts = [
    mcpServerNames.length > 0 ? `MCP ${mcpServerNames.length} 台` : undefined,
    commandRoots.length > 0 ? '带来命令' : undefined,
    sessionStartSkill === undefined ? undefined : '会话开始装载技能',
    promptSources.length > 0 ? '注入系统提示词' : undefined,
  ].filter((part) => part !== undefined)

  return parts.length === 0 ? '清单没有声明会带来什么' : parts.join(' · ')
}

/*
 * 判空交给标准库：Array.prototype.join 规定 undefined 与 null 元素渲染成空串
 * （ECMA-262 23.1.3.18），所以逐个字段判一遍是在手搓一件已经被解决的事。
 * 分隔符取换行而不是空串，免得相邻两个字段的拼接处凑出一个本不存在的匹配。
 */
function matches(needle: string, ...fields: readonly (string | undefined)[]): boolean {
  return needle === '' || fields.join('\n').toLowerCase().includes(needle.toLowerCase())
}

export interface PluginBrowserProps {
  readonly plugins: readonly InstalledPlugin[]
  readonly foreign: readonly ForeignPlugin[]
  readonly marketplace: MarketplaceState
  readonly install: InstallFlow
  readonly loaded: boolean
  readonly needle: string
  readonly store: PluginStore
  readonly onOpen: (id: string) => void
}

export function PluginBrowser({
  foreign,
  install,
  loaded,
  marketplace,
  needle,
  onOpen,
  plugins,
  store,
}: PluginBrowserProps) {
  const catalog = latestCatalog(marketplace)
  const installedIds = new Set(plugins.map((plugin) => plugin.pluginId))
  const foreignIds = new Set(foreign.map((record) => record.pluginId))
  const catalogIds = new Set((catalog?.entries ?? []).map((entry) => entry.id))
  /*
   * 目录里有的那些不单独列一遍：卡片上那个标记已经把同一件事说完了，列两遍等于让人
   * 在两处读到同一句话，还得自己判断它们说的是不是一回事。
   */
  const elsewhere = foreign.filter(
    (record) =>
      !catalogIds.has(record.pluginId) && matches(needle, record.pluginId, record.originalSource),
  )
  const listed = (catalog?.entries ?? []).filter(
    (entry) =>
      !installedIds.has(entry.id) &&
      matches(needle, entry.displayName, entry.id, entry.description),
  )
  const installed = plugins.filter((plugin) =>
    matches(needle, plugin.manifest.displayName, plugin.pluginId, plugin.manifest.description),
  )

  return (
    <div className="pb-20">
      <AddPluginForm store={store} />
      <InstallBanner install={install} store={store} />
      {installed.length > 0 ? (
        <Section title="已安装">
          <ul className="divide-y divide-divider">
            {installed.map((plugin) => (
              <li className="flex items-center gap-3 py-3" key={plugin.pluginId}>
                <PluginGlyph
                  displayName={plugin.manifest.displayName}
                  id={plugin.pluginId}
                  size="sm"
                />
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onOpen(plugin.pluginId)}
                  type="button"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {plugin.manifest.displayName}
                    </span>
                    <TrustBadge trust={plugin.trust} />
                    {plugin.enabled ? null : (
                      <span className="text-[11px] text-muted-foreground">已关闭</span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {capabilitySummary(plugin)}
                  </span>
                </button>
                <Button onClick={() => store.remove(plugin.pluginId)} size="xs" variant="ghost">
                  卸载
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <ForeignList records={elsewhere} store={store} />
      <CatalogGrid
        entries={listed.filter((entry) => entry.trust !== 'third-party')}
        foreignIds={foreignIds}
        onOpen={onOpen}
        title="精选"
      />
      <CatalogGrid
        entries={listed.filter((entry) => entry.trust === 'third-party')}
        foreignIds={foreignIds}
        onOpen={onOpen}
        title="更多"
      />
      {loaded && installed.length === 0 && listed.length === 0 && elsewhere.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {needle === '' ? '目录还没取到。点右上角刷新试试。' : `没有匹配「${needle}」的插件。`}
        </p>
      ) : null}
    </div>
  )
}

interface ForeignListProps {
  readonly records: readonly ForeignPlugin[]
  readonly store: PluginStore
}

/*
 * 命令行上装过、这里没有的那些。
 *
 * 「装在哪」不是一句废话：我们开出去的会话把 home 变量指向受控 home，命令行上那个家
 * 里的插件一个都不参与会话。所以这一节不写「已安装」，写的是它记在哪本账里、以及怎么
 * 把它装到这边来。
 *
 * 导入就是按原来那串地址重装一次，走的是与手动输入完全同一条路 —— 没有第二套安装
 * 通道，也就没有第二处会与它走样的判断。
 */
function ForeignList({ records, store }: ForeignListProps) {
  if (records.length === 0) {
    return null
  }

  return (
    <Section title="命令行上装过">
      <p className="pb-2 text-xs leading-5 text-muted-foreground">
        这些插件记在 {records[0]?.location} 里。本应用开出去的会话读的是它自己那份账本，
        所以它们在这里没有装上；导入会按原来的地址重装一次。
      </p>
      <ul className="divide-y divide-divider">
        {records.map((record) => (
          <li className="flex items-center gap-3 py-3" key={record.pluginId}>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{record.pluginId}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {record.originalSource ?? '那条记录没有记下当初的安装地址，导入不了'}
              </span>
            </div>
            {record.originalSource === undefined ? null : (
              <Button onClick={() => store.beginInstall(parseInstallSource(record.originalSource))}>
                导入
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}

interface SectionProps {
  readonly title: string
  readonly children: React.ReactNode
}

function Section({ children, title }: SectionProps) {
  return (
    <section className="pt-8">
      <h2 className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

interface CatalogGridProps {
  readonly entries: readonly MarketplaceEntry[]
  readonly title: string
  /** 在命令行那本账里出现过的 id。卡片仍然可装 —— 这里没装是事实，标记只是说清原因。 */
  readonly foreignIds: ReadonlySet<string>
  readonly onOpen: (id: string) => void
}

function CatalogGrid({ entries, foreignIds, onOpen, title }: CatalogGridProps) {
  if (entries.length === 0) {
    return null
  }

  return (
    <Section title={title}>
      <div className="grid gap-3 sm:grid-cols-2">
        {entries.map((entry) => (
          <article
            className="relative flex gap-3 rounded-xl border border-divider bg-background p-4 transition-colors hover:border-foreground/20"
            key={entry.id}
          >
            <PluginGlyph displayName={entry.displayName} id={entry.id} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <button
                  className="truncate text-sm font-medium after:absolute after:inset-0"
                  onClick={() => onOpen(entry.id)}
                  type="button"
                >
                  {entry.displayName}
                </button>
                <TrustBadge trust={entry.trust} />
                {foreignIds.has(entry.id) ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">CLI 已装</span>
                ) : null}
              </div>
              <p className="line-clamp-2 pt-1 text-xs leading-5 text-muted-foreground">
                {entry.description ?? describeInstallSource(entry.source)}
              </p>
            </div>
          </article>
        ))}
      </div>
    </Section>
  )
}

interface AddPluginFormProps {
  readonly store: PluginStore
}

/*
 * 手动来源那条通道。
 *
 * 输入串到底是本地目录、直链压缩包还是 GitHub 仓库，由 parseInstallSource 一处
 * 判定 —— 界面不认这三种形态，也就不会跟领域层判得不一样。
 */
function AddPluginForm({ store }: AddPluginFormProps) {
  const [text, setText] = useState('')

  return (
    <form
      className="flex gap-2 pt-6"
      onSubmit={(event) => {
        event.preventDefault()

        const specifier = text.trim()

        if (specifier === '') {
          return
        }

        store.beginInstall(parseInstallSource(specifier))
        setText('')
      }}
    >
      <input
        className="h-9 min-w-0 flex-1 rounded-lg border border-divider bg-background px-3 text-sm outline-none focus:border-foreground/25"
        onChange={(event) => setText(event.target.value)}
        placeholder="本地目录、.zip 直链，或 github.com/owner/repo"
        value={text}
      />
      <Button size="sm" type="submit" variant="secondary">
        添加
      </Button>
    </form>
  )
}

interface InstallBannerProps {
  readonly install: InstallFlow
  readonly store: PluginStore
}

function InstallBanner({ install, store }: InstallBannerProps) {
  if (install.kind === 'idle') {
    return null
  }

  if (install.kind === 'staging') {
    return (
      <p className="pt-4 text-xs text-muted-foreground">
        正在取 {describeInstallSource(install.source)}…
      </p>
    )
  }

  if (install.kind === 'refused') {
    return (
      <div className="flex items-center gap-3 pt-4">
        <p className="flex-1 text-xs text-destructive">{install.reason}</p>
        <Button onClick={() => store.cancelInstall()} size="xs" variant="ghost">
          知道了
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-divider bg-background p-4">
      <p className="text-sm font-medium">{install.manifest.displayName}</p>
      {/*
        装之前只知道清单说了什么。技能与命令由 CLI 在装载时自己读，所以这里只说清单里确实
        写着的那几台 MCP 服务器，也不承诺详情页会列出技能 —— 列它们的是「技能」那一格。
      */}
      <p className="pt-1 text-xs leading-5 text-muted-foreground">
        来自 {describeInstallSource(install.source)}。
        {install.manifest.mcpServerNames.length === 0
          ? '装上之后它带来的技能会出现在「技能」那一格里。'
          : `它会启动 ${install.manifest.mcpServerNames.length} 台 MCP 服务器；技能出现在「技能」那一格里。`}
      </p>
      {install.diagnostics.map((diagnostic) => (
        <p className="pt-1 text-xs text-muted-foreground" key={diagnostic.detail}>
          {diagnostic.detail}
        </p>
      ))}
      <div className="flex gap-2 pt-3">
        <Button onClick={() => store.confirmInstall()} size="sm">
          安装
        </Button>
        <Button onClick={() => store.cancelInstall()} size="sm" variant="ghost">
          取消
        </Button>
      </div>
    </div>
  )
}
