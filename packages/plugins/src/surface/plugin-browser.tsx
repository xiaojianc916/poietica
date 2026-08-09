import { Button } from '@poietica/ui'
import { useState } from 'react'

import { describeInstallSource, parseInstallSource } from '../install-source'
import type { InstalledPlugin } from '../installation'
import { latestCatalog, type MarketplaceEntry, type MarketplaceState } from '../marketplace'
import type { InstallFlow, PluginStore } from '../plugin-store'
import { PluginGlyph } from './plugin-glyph'
import { TrustBadge } from './trust-badge'

/*
 * 目录页。
 *
 * 「装了什么」不在这里判 —— 传进来的 plugins 就是磁盘上那一份，这里只做减法：
 * 已经在盘上的条目不再出现在下面的目录网格里，而是升到上面那一行「已安装」。
 */

/* 数的是真的读到的那些：清单声明几条路径不是能力，路径下有什么才是。 */
function capabilitySummary(plugin: InstalledPlugin): string {
  const { mcpServers } = plugin.manifest
  const { commands, skills } = plugin.registry

  const parts = [
    skills.length > 0 ? `技能 ${skills.length} 个` : undefined,
    commands.length > 0 ? `命令 ${commands.length} 条` : undefined,
    mcpServers.length > 0 ? `MCP ${mcpServers.length} 台` : undefined,
  ].filter((part) => part !== undefined)

  return parts.length === 0 ? '没有带来可调用的能力' : parts.join(' · ')
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
  readonly marketplace: MarketplaceState
  readonly install: InstallFlow
  readonly loaded: boolean
  readonly needle: string
  readonly store: PluginStore
  readonly onOpen: (id: string) => void
}

export function PluginBrowser({
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
      <CatalogGrid
        entries={listed.filter((entry) => entry.trust !== 'third-party')}
        onOpen={onOpen}
        title="精选"
      />
      <CatalogGrid
        entries={listed.filter((entry) => entry.trust === 'third-party')}
        onOpen={onOpen}
        title="更多"
      />
      {loaded && installed.length === 0 && listed.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {needle === '' ? '目录还没取到。点右上角刷新试试。' : `没有匹配「${needle}」的插件。`}
        </p>
      ) : null}
    </div>
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
  readonly onOpen: (id: string) => void
}

function CatalogGrid({ entries, onOpen, title }: CatalogGridProps) {
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
        装之前只知道清单说了什么：技能与命令要装完扫盘才数得出来。所以这里只说清单里确实
        写着的那几台 MCP 服务器，不拿声明的路径条数冒充技能个数。
      */}
      <p className="pt-1 text-xs leading-5 text-muted-foreground">
        来自 {describeInstallSource(install.source)}。
        {install.manifest.mcpServers.length === 0
          ? '装上之后它带来的技能与命令会列在详情页里。'
          : `它会启动 ${install.manifest.mcpServers.length} 台 MCP 服务器；技能与命令装完列在详情页里。`}
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
