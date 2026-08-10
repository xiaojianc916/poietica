import { Button } from '@poietica/ui'
import { useState } from 'react'

import { describeInstallSource, parseInstallSource } from '../install-source'
import type { InstalledPlugin } from '../installation'
import {
  buildListing,
  type CapabilityPromo,
  countRows,
  type ListingRow,
  type ListingStatus,
  matches,
  PLUGIN_TABS,
  type PluginTabId,
  statusText,
} from '../listing'
import { latestCatalog, type MarketplaceEntry, type MarketplaceState } from '../marketplace'
import type { ForeignPlugin, InstallFlow, PluginStore } from '../plugin-store'
import { PluginGlyph } from './plugin-glyph'
import { TrustBadge } from './trust-badge'

/*
 * 目录页。
 *
 * 四格照官方 /plugins 面板：已安装 / 官方 / 精选 / 手动添加。此前是「精选」「更多」按背书
 * 硬分两栏，而且目录里已经装上的那些被直接抹掉 —— 人回目录里找一个自己装过的插件，它就是
 * 不在，屏幕对此一言不发。现在它留在原处，状态那一列写「已安装」，并排到最前。
 *
 * 分格与状态怎么算不在这里，在 ../listing。这一份只画。
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
  const [tab, setTab] = useState<PluginTabId>('installed')

  const catalog = latestCatalog(marketplace)
  const entries = catalog?.entries ?? []
  const listing = buildListing({
    elsewhereIds: new Set(foreign.map((record) => record.pluginId)),
    entries,
    installed: plugins,
    needle,
  })

  const installed = plugins.filter((plugin) =>
    matches(needle, plugin.manifest.displayName, plugin.pluginId, plugin.manifest.description),
  )

  /*
   * 目录里有的那些不在这一节单独列一遍：那一行已经在「官方」或「精选」那一格里，状态写着
   * 「命令行里装过」。列两遍等于让人在两处读到同一句话，还得自己判断说的是不是一回事。
   */
  const catalogIds = new Set(entries.map((entry) => entry.id))
  const elsewhere = foreign.filter(
    (record) =>
      !catalogIds.has(record.pluginId) && matches(needle, record.pluginId, record.originalSource),
  )

  return (
    <div className="pb-20">
      <InstallBanner install={install} store={store} />
      <TabStrip onSelect={setTab} tab={tab} />
      {tab === 'installed' ? (
        <InstalledTab
          elsewhere={elsewhere}
          installed={installed}
          loaded={loaded}
          needle={needle}
          onOpen={onOpen}
          store={store}
        />
      ) : null}
      {tab === 'official' ? (
        <CatalogTab
          hasCatalog={catalog !== undefined}
          needle={needle}
          onOpen={onOpen}
          rows={listing.official}
          store={store}
        />
      ) : null}
      {tab === 'curated' ? (
        <CatalogTab
          hasCatalog={catalog !== undefined}
          needle={needle}
          onOpen={onOpen}
          rows={listing.curated}
          store={store}
        />
      ) : null}
      {tab === 'custom' ? <CustomTab store={store} /> : null}
    </div>
  )
}

interface TabStripProps {
  readonly onSelect: (id: PluginTabId) => void
  readonly tab: PluginTabId
}

function TabStrip({ onSelect, tab }: TabStripProps) {
  return (
    <div className="flex gap-1 pt-6" role="tablist">
      {PLUGIN_TABS.map((entry) => (
        <button
          aria-selected={entry.id === tab}
          className={
            entry.id === tab
              ? 'rounded-lg bg-foreground/10 px-3 py-1.5 text-xs font-medium'
              : 'rounded-lg px-3 py-1.5 text-xs text-muted-foreground'
          }
          key={entry.id}
          onClick={() => onSelect(entry.id)}
          role="tab"
          type="button"
        >
          {entry.label}
        </button>
      ))}
    </div>
  )
}

interface InstalledTabProps {
  readonly elsewhere: readonly ForeignPlugin[]
  readonly installed: readonly InstalledPlugin[]
  readonly loaded: boolean
  readonly needle: string
  readonly onOpen: (id: string) => void
  readonly store: PluginStore
}

function InstalledTab({ elsewhere, installed, loaded, needle, onOpen, store }: InstalledTabProps) {
  /* 首帧与「读完了确实一个都没装」不是同一件事，所以空态等账本读完才出现。 */
  if (loaded && installed.length === 0 && elsewhere.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        {needle === '' ? '还没有装插件。到「官方」那一格看看。' : `没有匹配「${needle}」的插件。`}
      </p>
    )
  }

  return (
    <>
      <ul className="divide-y divide-divider pt-2">
        {installed.map((plugin) => (
          <li className="flex items-center gap-3 py-3" key={plugin.pluginId}>
            <PluginGlyph displayName={plugin.manifest.displayName} id={plugin.pluginId} size="sm" />
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => onOpen(plugin.pluginId)}
              type="button"
            >
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{plugin.manifest.displayName}</span>
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
      <ForeignList records={elsewhere} store={store} />
    </>
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
    <section className="pt-8">
      <h3 className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        命令行上装过
      </h3>
      <p className="pb-2 text-xs leading-5 text-muted-foreground">
        这些插件记在 {records[0]?.location} 里。本应用开出去的会话读的是它自己那份账本，
        所以它们在这里没有装上；导入会按原来的地址重装一次。
      </p>
      {/*
        解构不是为了短。originalSource === undefined 那道收窄只对 const 绑定穿透进闭包；
        属性访问在 onClick 这个收窄之后才建的函数里会被重新看成 string | undefined ——
        属性在回调真正执行时可能已经变了，这是控制流分析的既定行为，不是配置问题。
      */}
      <ul className="divide-y divide-divider">
        {records.map(({ originalSource, pluginId }) => (
          <li className="flex items-center gap-3 py-3" key={pluginId}>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{pluginId}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {originalSource ?? '那条记录没有记下当初的安装地址，导入不了'}
              </span>
            </div>
            {originalSource === undefined ? null : (
              <Button onClick={() => store.beginInstall(parseInstallSource(originalSource))}>
                导入
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

interface CatalogTabProps {
  readonly hasCatalog: boolean
  readonly needle: string
  readonly onOpen: (id: string) => void
  readonly rows: readonly ListingRow[]
  readonly store: PluginStore
}

function CatalogTab({ hasCatalog, needle, onOpen, rows, store }: CatalogTabProps) {
  if (rows.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        {emptyText(hasCatalog, needle)}
      </p>
    )
  }

  const counts = countRows(rows)

  return (
    <>
      <p className="pt-3 text-[11px] text-muted-foreground">
        已装 {counts.installed} · 可装 {counts.available}
      </p>
      <ul className="divide-y divide-divider">
        {rows.map((row) =>
          row.kind === 'promo' ? (
            <PromoItem key={row.promo.id} promo={row.promo} />
          ) : (
            <CatalogItem
              entry={row.entry}
              key={row.entry.id}
              onOpen={onOpen}
              status={row.status}
              store={store}
            />
          ),
        )}
      </ul>
    </>
  )
}

/* 「目录没取到」和「取到了但这一格是空的」不是同一句话，所以分开说。 */
function emptyText(hasCatalog: boolean, needle: string): string {
  if (!hasCatalog) {
    return '目录还没取到。点右上角刷新试试。'
  }

  return needle === '' ? '这一格现在是空的。' : `没有匹配「${needle}」的插件。`
}

interface CatalogItemProps {
  readonly entry: MarketplaceEntry
  readonly onOpen: (id: string) => void
  readonly status: ListingStatus
  readonly store: PluginStore
}

function CatalogItem({ entry, onOpen, status, store }: CatalogItemProps) {
  return (
    <li className="flex items-center gap-3 py-3">
      <PluginGlyph displayName={entry.displayName} id={entry.id} size="sm" />
      <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(entry.id)} type="button">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.displayName}</span>
          <TrustBadge trust={entry.trust} />
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {entry.description ?? describeInstallSource(entry.source)}
        </span>
      </button>
      <span className="shrink-0 text-[11px] text-muted-foreground">{statusText(status)}</span>
      {/* 命令行那本账里有过也照样可装：那一份不参与本应用的会话，装是真的要装。 */}
      {status.kind === 'installed' ? null : (
        <Button onClick={() => store.beginInstall(entry.source)} size="xs" variant="secondary">
          安装
        </Button>
      )}
    </li>
  )
}

interface PromoItemProps {
  readonly promo: CapabilityPromo
}

/*
 * 官方能力那一行。没有安装按钮 —— 理由写在 ../listing 的 CAPABILITY_PROMOS 上。
 *
 * 说明是一个普通 <a>：外链在渲染层由 capture 阶段的一个委托统一交给系统浏览器
 * （apps/desktop/src/chrome/external-links.ts，原生侧再过一遍协议白名单），所以这一层
 * 不需要认识那条通道，也不该认识。
 */
function PromoItem({ promo }: PromoItemProps) {
  return (
    <li className="flex items-center gap-3 py-3">
      <PluginGlyph displayName={promo.displayName} id={promo.id} size="sm" />
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{promo.displayName}</span>
          <TrustBadge trust="kimi-official" />
        </span>
        <span className="block text-xs leading-5 text-muted-foreground">{promo.description}</span>
      </div>
      <span className="shrink-0 text-[11px] text-muted-foreground">在命令行里装</span>
      {promo.homepage === undefined ? null : (
        <a className="shrink-0 text-[11px] text-muted-foreground underline" href={promo.homepage}>
          说明
        </a>
      )}
    </li>
  )
}

interface CustomTabProps {
  readonly store: PluginStore
}

/*
 * 手动来源那条通道。
 *
 * 输入串到底是本地目录、直链压缩包还是 GitHub 仓库，由 parseInstallSource 一处判定 ——
 * 界面不认这三种形态，也就不会跟领域层判得不一样。分支那条规矩先写出来：GitHub 地址不
 * 指明分支、标签或提交时取不动，与其让人按下去才看见那句话，不如先说。
 */
function CustomTab({ store }: CustomTabProps) {
  const [text, setText] = useState('')

  return (
    <>
      <form
        className="flex gap-2 pt-4"
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
      <p className="pt-2 text-xs leading-5 text-muted-foreground">
        GitHub 地址要指明分支、标签或提交，例如 github.com/owner/repo/tree/main。
      </p>
    </>
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

  /*
   * 官方来源之外一律要人点头，而默认落在安全那一侧：取消在前、是主按钮，确认降为次要。
   * 装上之后它带来的技能、命令与 MCP 服务器就在会话里跑起来了，这一步是那件事发生前的
   * 最后一道闸，把它做成一路回车就过去的形状等于没有这道闸。
   */
  const stranger = install.trust !== 'kimi-official'

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
      {stranger ? (
        <p className="pt-2 text-xs leading-5 text-destructive">
          这个来源不在官方目录里。装上之后它的技能、命令与 MCP 服务器会在你的会话里运行，
          只装你认得的来源。
        </p>
      ) : null}
      <div className="flex gap-2 pt-3">
        {stranger ? (
          <>
            <Button onClick={() => store.cancelInstall()} size="sm" variant="secondary">
              取消
            </Button>
            <Button onClick={() => store.confirmInstall()} size="sm" variant="ghost">
              仍然安装
            </Button>
          </>
        ) : (
          <Button onClick={() => store.confirmInstall()} size="sm">
            安装
          </Button>
        )}
      </div>
    </div>
  )
}
