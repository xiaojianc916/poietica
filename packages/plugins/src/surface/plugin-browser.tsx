import { Button } from '@poietica/ui'
import { useState } from 'react'

import {
  type CatalogRow,
  groupRows,
  matches,
  personalPluginRows,
  publicPluginRows,
} from '../catalog/listing'
import { describeInstallSource, parseInstallSource } from '../install-source'
import type { InstalledPlugin } from '../installation'
import type { MarketplaceEntry } from '../marketplace'
import type { ForeignPlugin, InstallFlow, PluginStore } from '../plugin-store'
import { CatalogGrid } from './catalog-grid'
import { PluginGlyph } from './plugin-glyph'
import { TrustBadge } from './trust-badge'

/*
 * 插件那一格。一层导航，两段内容：公开名单在上，个人的在下。
 *
 * 此前这里嵌着第二层 tab（已安装 / 官方 / 精选 / 手动添加），与外层那三格是两套并行的导航
 * 模型，切出去再切回来内层选中项还会被重置 —— 人回到的不是他离开的那一页。
 *
 * 公开与个人的区别不是背书，是名单归属：公开名单不归用户所有，所以卸载只把状态拨回「可安
 * 装」，卡片留在原处随时装回来；个人那张卡片本身就是用户造出来的，删掉就该一起消失。这条
 * 判据只在 catalog/scope 里说一次。
 */

export interface PluginBrowserProps {
  readonly plugins: readonly InstalledPlugin[]
  readonly entries: readonly MarketplaceEntry[]
  readonly foreign: readonly ForeignPlugin[]
  readonly install: InstallFlow
  readonly loaded: boolean
  readonly needle: string
  readonly store: PluginStore
  readonly onOpen: (id: string) => void
}

export function PluginBrowser({
  entries,
  foreign,
  install,
  loaded,
  needle,
  onOpen,
  plugins,
  store,
}: PluginBrowserProps) {
  const publicRows = publicPluginRows({
    elsewhereIds: new Set(foreign.map((record) => record.pluginId)),
    entries,
    installed: plugins,
    needle,
  })

  const personalRows = personalPluginRows(plugins, needle)

  /*
   * 名单里有的那些不在「命令行装过」里再列一遍：那一行已经在上面，状态写着「命令行里装
   * 过」。列两遍等于让人在两处读到同一句话，还得自己判断说的是不是一回事。
   */
  const catalogIds = new Set(entries.map((entry) => entry.id))
  const elsewhere = foreign.filter(
    (record) =>
      !catalogIds.has(record.pluginId) && matches(needle, record.pluginId, record.originalSource),
  )

  return (
    <div className="pb-20">
      <InstallBanner install={install} store={store} />
      <CatalogGrid groups={groupRows(publicRows)} onInstall={store.beginInstall} onOpen={onOpen} />
      <PersonalSection
        elsewhere={elsewhere}
        loaded={loaded}
        onOpen={onOpen}
        rows={personalRows}
        store={store}
      />
      <CustomSource store={store} />
    </div>
  )
}

interface PersonalSectionProps {
  readonly rows: readonly CatalogRow[]
  readonly elsewhere: readonly ForeignPlugin[]
  readonly loaded: boolean
  readonly onOpen: (id: string) => void
  readonly store: PluginStore
}

function PersonalSection({ elsewhere, loaded, onOpen, rows, store }: PersonalSectionProps) {
  if (!loaded || (rows.length === 0 && elsewhere.length === 0)) {
    return null
  }

  return (
    <section className="pt-10">
      <h2 className="pb-1 text-sm font-medium">个人</h2>
      <p className="pb-3 text-xs leading-5 text-muted-foreground">
        你自己添加的。删除会连这张卡片一起消失 —— 它不在任何名单上，没有地方能把它找回来。
      </p>
      <ul className="divide-y divide-divider">
        {rows.map((row) => (
          <li className="flex items-center gap-3 py-3" key={row.key}>
            <PluginGlyph displayName={row.displayName} id={row.id} size="sm" />
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => onOpen(row.id)}
              type="button"
            >
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{row.displayName}</span>
                <TrustBadge trust="third-party" />
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {row.description}
              </span>
            </button>
            <Button onClick={() => store.remove(row.id)} size="xs" variant="ghost">
              删除
            </Button>
          </li>
        ))}
      </ul>
      <ForeignList records={elsewhere} store={store} />
    </section>
  )
}

interface ForeignListProps {
  readonly records: readonly ForeignPlugin[]
  readonly store: PluginStore
}

/*
 * 命令行上装过、这里没有的那些。
 *
 * 「装在哪」不是废话：我们开出去的会话把 home 指向受控 home，命令行那个家里的插件一个都不
 * 参与会话。导入就是按原来那串地址重装一次，走的是与手动输入完全同一条路。
 */
function ForeignList({ records, store }: ForeignListProps) {
  if (records.length === 0) {
    return null
  }

  return (
    <div className="pt-6">
      <h3 className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        命令行上装过
      </h3>
      <p className="pb-2 text-xs leading-5 text-muted-foreground">
        这些插件记在 {records[0]?.location} 里。本应用开出去的会话读的是它自己那本账，所以它们
        在这里没有装上；导入会按原来的地址重装一次。
      </p>
      <ul className="divide-y divide-divider">
        {/*
          解构不是为了短。originalSource === undefined 那道收窄只对 const 绑定穿透进闭包；
          属性访问在 onClick 这个收窄之后才建的函数里会被重新看成 string | undefined ——
          属性在回调真正执行时可能已经变了，这是控制流分析的既定行为。
        */}
        {records.map(({ originalSource, pluginId }) => (
          <li className="flex items-center gap-3 py-3" key={pluginId}>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{pluginId}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {originalSource ?? '那条记录没有记下当初的安装地址，导入不了'}
              </span>
            </div>
            {originalSource === undefined ? null : (
              <Button
                onClick={() => store.beginInstall(parseInstallSource(originalSource))}
                size="xs"
                variant="secondary"
              >
                导入
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

interface CustomSourceProps {
  readonly store: PluginStore
}

/*
 * 手动来源那条通道。
 *
 * 输入串到底是本地目录、直链压缩包还是 GitHub 仓库，由 parseInstallSource 一处判定 —— 界面
 * 不认这三种形态，也就不会跟领域层判得不一样。
 */
function CustomSource({ store }: CustomSourceProps) {
  const [text, setText] = useState('')

  return (
    <section className="pt-10">
      <h2 className="pb-1 text-sm font-medium">从地址添加</h2>
      <p className="pb-3 text-xs leading-5 text-muted-foreground">
        添加进来的算个人插件。GitHub 地址要指明分支、标签或提交，例如
        github.com/owner/repo/tree/main。
      </p>
      <form
        className="flex gap-2"
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
    </section>
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
      <div className="flex items-center gap-3 pt-4">
        <p className="flex-1 text-xs text-muted-foreground">
          正在取 {describeInstallSource(install.source)}…
        </p>
        <Button onClick={() => store.cancelInstall()} size="xs" variant="ghost">
          取消
        </Button>
      </div>
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
   * 官方来源之外一律要人点头，默认落在安全那一侧：取消在前、是主按钮，确认降为次要。装上
   * 之后它带来的技能、命令与 MCP 服务器就在会话里跑起来了，把这道闸做成一路回车就过去的
   * 形状，等于没有这道闸。
   */
  const servers = install.manifest.mcpServerNames.length

  return (
    <div className="mt-4 rounded-xl border border-divider bg-background p-4">
      <p className="text-sm font-medium">{install.manifest.displayName}</p>
      <p className="pt-1 text-xs leading-5 text-muted-foreground">
        来自 {describeInstallSource(install.source)}。
        {servers === 0
          ? '装上之后它带来的技能会出现在「技能」那一格里。'
          : `它会启动 ${servers} 台 MCP 服务器，装上之后可以在「MCP」那一格里逐台关掉。`}
      </p>
      {install.diagnostics.length === 0 ? null : (
        <ul className="pt-2">
          {install.diagnostics.map((entry) => (
            <li className="text-xs leading-5 text-muted-foreground" key={entry.code}>
              · {entry.detail}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 pt-3">
        <Button onClick={() => store.cancelInstall()} size="xs" variant="secondary">
          取消
        </Button>
        <Button onClick={() => store.confirmInstall()} size="xs" variant="ghost">
          仍要安装
        </Button>
      </div>
    </div>
  )
}
