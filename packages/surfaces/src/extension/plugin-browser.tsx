import { Button, Switch } from '@poietica/design-system'
import {
  describeInstallSource,
  type ForeignPlugin,
  groupRows,
  type InstalledPlugin,
  type InstallFlow,
  type MarketplaceEntry,
  matches,
  type PluginStore,
  parseInstallSource,
  publicPluginRows,
} from '@poietica/extension'
import { useState } from 'react'
import { CatalogGrid } from './catalog-grid'
import { ContributionList, type ContributionRow } from './contribution-list'
import { Section } from './section'
import { trustLabel } from './trust-badge'

/*
 * 插件那一格：已安装在上，发现在下，最后是命令行那本账与从地址添加。
 *
 * 此前装在这里的插件没有一处能停用 —— store 上的 setEnabled 与账本里的 enabled 一直都在，
 * 界面从来没有把它接出来，人只有卸载这一条路。开关因此长在已装那一行上：停用不删记录，
 * 下一次会话不装载它，随时拨得回来。
 *
 * 「个人」不再单列一段。装了就是装了，来源是行上那一枚标；分两段列意味着同一件事有两条
 * 渲染路径，而人要找「我装的那个」得先想清楚它算公开还是个人。卸载之后卡片留不留，判据
 * 写在 catalog-grid.tsx 的 CardAction 头注释里。
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
  const installedRows = plugins
    .filter((plugin) =>
      matches(needle, plugin.manifest.displayName, plugin.pluginId, plugin.manifest.description),
    )
    .map((plugin) => pluginRow(plugin, onOpen, store))

  const publicRows = publicPluginRows({
    elsewhereIds: new Set(foreign.map((record) => record.pluginId)),
    entries,
    installed: plugins,
    needle,
  })

  /*
   * 名单里有的那些不在「命令行装过」里再列一遍：那一条已经在上面，状态写着「命令行里装
   * 过」。列两遍等于让人在两处读到同一句话，还得自己判断说的是不是一回事。
   */
  const catalogIds = new Set(entries.map((entry) => entry.id))
  const elsewhere = foreign.filter(
    (record) =>
      !catalogIds.has(record.pluginId) && matches(needle, record.pluginId, record.originalSource),
  )

  return (
    <div className="pb-24">
      <InstallBanner install={install} store={store} />
      <Section count={installedRows.length} title="已安装">
        <ContributionList
          empty={
            loaded
              ? '这里还没有装插件。下面那份名单里挑一个，或者从地址添加。'
              : '正在读 agent 的账本…'
          }
          rows={installedRows}
        />
      </Section>
      <CatalogGrid
        action={{ kind: 'plugin', install: store.beginInstall, open: onOpen }}
        groups={groupRows(publicRows)}
      />
      <ForeignList records={elsewhere} store={store} />
      <CustomSource store={store} />
    </div>
  )
}

/*
 * 一行是账本里的一条记录。开关拨的是那条记录的 enabled，移除是把那条记录整个拿掉 ——
 * 两个动作落在同一份真相上，所以它们并排放得下。
 */
function pluginRow(
  plugin: InstalledPlugin,
  onOpen: (id: string) => void,
  store: PluginStore,
): ContributionRow {
  const described =
    plugin.source === undefined
      ? '从地址装进来的，名单上查不到它'
      : describeInstallSource(plugin.source)

  return {
    key: plugin.pluginId,
    title: plugin.manifest.displayName,
    detail: plugin.manifest.description ?? described,
    badge: trustLabel(plugin.trust),
    dimmed: !plugin.enabled,
    onOpen: () => onOpen(plugin.pluginId),
    trailing: (
      <>
        <Button
          className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => store.remove(plugin.pluginId)}
          size="xs"
          variant="ghost"
        >
          移除
        </Button>
        <Switch
          aria-label={`启用 ${plugin.manifest.displayName}`}
          checked={plugin.enabled}
          onCheckedChange={(next) => store.setEnabled(plugin.pluginId, next)}
          size="sm"
        />
      </>
    ),
  }
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
    <Section
      count={records.length}
      hint={`这些插件记在 ${records[0]?.location} 里。本应用开出去的会话读的是它自己那本账，所以它们在这里没有装上；导入会按原来的地址重装一次。`}
      title="命令行上装过"
    >
      <ContributionList
        rows={records.map(({ originalSource, pluginId }) => ({
          /*
            解构不是为了短。originalSource === undefined 那道收窄只对 const 绑定穿透进闭包；
            属性访问在 onClick 这个收窄之后才建的函数里会被重新看成 string | undefined ——
            属性在回调真正执行时可能已经变了，这是控制流分析的既定行为。
          */
          key: `foreign/${pluginId}`,
          title: pluginId,
          detail: originalSource ?? '那条记录没有记下当初的安装地址，导入不了',
          trailing:
            originalSource === undefined ? undefined : (
              <Button
                onClick={() => store.beginInstall(parseInstallSource(originalSource))}
                size="xs"
                variant="soft"
              >
                导入
              </Button>
            ),
        }))}
      />
    </Section>
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
    <Section
      hint="添加进来的插件同样出现在上面的「已安装」里。GitHub 地址要指明分支、标签或提交，例如 github.com/owner/repo/tree/main。"
      title="从地址添加"
    >
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
          className="h-9 min-w-0 flex-1 rounded-xl bg-muted/60 px-3 text-[13px] outline-none ring-1 ring-transparent transition-[background-color,box-shadow] focus:bg-background focus:ring-foreground/10"
          onChange={(event) => setText(event.target.value)}
          placeholder="本地目录、.zip 直链，或 github.com/owner/repo"
          value={text}
        />
        <Button size="sm" type="submit" variant="soft">
          添加
        </Button>
      </form>
    </Section>
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
      <div className="mt-6 flex items-center gap-3 rounded-2xl bg-muted/50 px-4 py-3">
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
      <div className="mt-6 flex items-center gap-3 rounded-2xl bg-muted/50 px-4 py-3">
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
    <div className="mt-6 rounded-2xl bg-muted/50 p-4">
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
