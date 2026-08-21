import type { PaletteEntry } from '@poietica/agent-contract'
import { assertUnreachable } from '@poietica/core'
import { Button, cn, Switch } from '@poietica/ui'
import { useState, useSyncExternalStore } from 'react'

import { builtinServerRows, builtinSkillRows, groupRows, matches } from '../catalog/listing'
import { latestCatalog, type MarketplaceEntry } from '../marketplace'
import type { ResolvedMcpServer } from '../mcp-servers'
import { type ContributionOrigin, describeOrigin } from '../origin'
import type { PluginStore, PluginsViewModel } from '../plugin-store'
import type { InstalledSkill } from '../skill'
import { CatalogGrid } from './catalog-grid'
import { ContributionList, type ContributionRow } from './contribution-list'
import { PluginBrowser } from './plugin-browser'
import { PluginDetail } from './plugin-detail'
import { Section } from './section'

/*
 * 扩展中心。三格：插件、技能、MCP。
 *
 * 技能与 MCP 不是两种插件 —— 插件是打包与分发单位，另外两样是它能带来的能力，所以那两格
 * 是投影，不是并列的第二套安装系统。
 *
 * 三格同构：上面「已安装」，下面「发现」。装了什么与能装什么是两个问题，混在一张列表里，
 * 人就得靠右边那个按钮的文案反推自己有没有装过。
 *
 * 每一格自己持有搜索词。共用一个搜索词会让占位符写着「搜索技能」而值是上一格的插件关键
 * 字，技能列表因此被过滤空 —— 那是个说谎的控件。
 */

const TABS = {
  plugins: {
    label: '插件',
    subtitle: '完整扩展包：可以自带技能、MCP 服务器与斜杠命令。装上它，能力就出现在对话里。',
  },
  skills: {
    label: '技能',
    subtitle:
      '工作流与提示模板，使用 /skill: 调用。插件带来的与全局装的由 agent 在会话建立后报来。',
  },
  mcp: {
    label: 'MCP',
    subtitle:
      '给对话新增可调用函数的外部工具服务：本应用自带的、这台机器上配好的、插件带来的，加上我们精选的名单。',
  },
} as const

type TabId = keyof typeof TABS

const TAB_ORDER = Object.keys(TABS) as readonly TabId[]

const EMPTY_NEEDLES: Record<TabId, string> = { plugins: '', skills: '', mcp: '' }

export interface PluginsSurfaceProps {
  readonly store: PluginStore
}

export function PluginsSurface({ store }: PluginsSurfaceProps) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [tab, setTab] = useState<TabId>('plugins')
  const [needles, setNeedles] = useState<Record<TabId, string>>(EMPTY_NEEDLES)
  const [openedId, setOpenedId] = useState<string | undefined>(undefined)

  const needle = needles[tab]
  const entries: readonly MarketplaceEntry[] = latestCatalog(view.marketplace)?.entries ?? []

  /*
   * 技能现在由 AgentSkillPort 单独管理，不在 palette 里。
   * palette 只包含斜杠命令。
   */
  const counts: Record<TabId, number> = {
    plugins: view.plugins.length,
    skills: view.skills.length,
    mcp: view.mcpServers.length,
  }

  if (openedId !== undefined) {
    return (
      <div className="plugins-scroll-region h-full overflow-y-auto overscroll-contain bg-ground">
        <div className="mx-auto w-full max-w-6xl px-10">
          <PluginDetail
            entry={entries.find((one) => one.id === openedId)}
            onBack={() => setOpenedId(undefined)}
            plugin={view.plugins.find((one) => one.pluginId === openedId)}
            store={store}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="plugins-scroll-region h-full overflow-y-auto overscroll-contain bg-ground">
      <div className="mx-auto w-full max-w-6xl px-10">
        <header className="pt-12 pb-5">
          <h1 className="text-[26px] font-semibold leading-none tracking-tight">扩展</h1>
          <p className="max-w-2xl pt-3 text-[13px] leading-6 text-muted-foreground">
            {TABS[tab].subtitle}
          </p>
        </header>
        <div className="sticky top-0 z-10 -mx-10 bg-ground/95 px-10 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <nav
              aria-label="扩展分类"
              className="flex items-center gap-1 rounded-full bg-muted/70 p-1"
            >
              {TAB_ORDER.map((one) => (
                <button
                  aria-selected={one === tab}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-xs transition-colors',
                    one === tab
                      ? 'bg-background font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  key={one}
                  onClick={() => setTab(one)}
                  role="tab"
                  type="button"
                >
                  {TABS[one].label}
                  <span className="pl-1.5 tabular-nums opacity-50">{counts[one]}</span>
                </button>
              ))}
            </nav>
            <input
              aria-label={`搜索${TABS[tab].label}`}
              className="h-9 min-w-0 flex-1 rounded-full bg-muted/60 px-4 text-[13px] outline-none ring-1 ring-transparent transition-[background-color,box-shadow] placeholder:text-muted-foreground/70 focus:bg-background focus:ring-foreground/10"
              onChange={(event) => setNeedles({ ...needles, [tab]: event.target.value })}
              placeholder={`搜索${TABS[tab].label}`}
              value={needle}
            />
            {/*
              技能那一格没有刷新按钮：命令表由 agent 推过来，AgentPalettePort 上只有 read 与
              subscribe，没有「再探一次」这个动作。画一个按下去什么都不会发生的按钮，比没有
              按钮坏。另外两格刷的是同一份市场目录，所以它们共用这一个。
            */}
            {tab === 'skills' ? null : (
              <Button onClick={() => store.refreshMarketplace()} size="sm" variant="ghost">
                刷新名单
              </Button>
            )}
          </div>
        </div>
        <TabBody
          entries={entries}
          needle={needle}
          onOpen={setOpenedId}
          store={store}
          tab={tab}
          view={view}
        />
      </div>
    </div>
  )
}

interface TabBodyProps {
  readonly tab: TabId
  readonly needle: string
  readonly entries: readonly MarketplaceEntry[]
  readonly store: PluginStore
  readonly view: PluginsViewModel
  readonly onOpen: (id: string) => void
}

function TabBody({ entries, needle, onOpen, store, tab, view }: TabBodyProps) {
  switch (tab) {
    case 'plugins':
      return (
        <PluginBrowser
          entries={entries}
          foreign={view.foreign}
          install={view.install}
          loaded={view.loaded}
          needle={needle}
          onOpen={onOpen}
          plugins={view.plugins}
          store={store}
        />
      )
    case 'skills': {
      const rows = view.skills
        .map((skill) => installedSkillRow(skill, store))
        .filter((row) => matches(needle, row.title, row.detail))

      return (
        <div className="pb-24">
          {view.skillInstall.kind === 'staging' ? (
            <div className="flex items-center gap-2 pt-6">
              <p className="text-xs text-muted-foreground">正在安装技能…</p>
              <Button onClick={store.cancelSkillInstall} size="xs" variant="ghost">
                取消
              </Button>
            </div>
          ) : null}
          {view.skillInstall.kind === 'refused' ? (
            <p className="pt-6 text-xs text-destructive">{view.skillInstall.reason}</p>
          ) : null}
          <Section count={rows.length} title="已安装">
            <ContributionList
              empty="这里还没有技能。下面那份名单一键装，装完在新会话里用 /skill: 调用。"
              rows={rows}
            />
          </Section>
          <CatalogGrid
            action={{ kind: 'skill', install: store.installSkill }}
            groups={groupRows(builtinSkillRows(view.skills, needle))}
          />
        </div>
      )
    }
    case 'mcp': {
      const rows = view.mcpServers
        .map((server) => serverRow(server, store))
        .filter((row) => matches(needle, row.title, row.detail, row.badge))

      return (
        <div className="pb-24">
          <Section count={rows.length} title="已安装">
            <ContributionList empty="这台机器上没有配置 MCP 服务器，插件也没有带来。" rows={rows} />
          </Section>
          <CatalogGrid
            action={{ kind: 'server', install: store.installEnvironmentServer }}
            groups={groupRows(builtinServerRows(view.mcpServers, needle))}
          />
        </div>
      )
    }
    default:
      return assertUnreachable(tab)
  }
}

/*
 * 装在受控 home 里的一个技能。移除即删目录；已开着的会话不受影响，新会话不再装载。
 */
function installedSkillRow(skill: InstalledSkill, store: PluginStore): ContributionRow {
  return {
    key: `installed/${skill.dirName}`,
    title: skill.manifest.name,
    detail: skill.manifest.description ?? '这个技能没有写说明。装好后由新会话装载。',
    badge: '已安装',
    trailing: (
      <Button
        className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => store.removeInstalledSkill(skill.dirName)}
        size="xs"
        variant="ghost"
      >
        移除
      </Button>
    ),
  }
}

/*
 * agent 报来的那些。它们不在这里的 skills/ 目录里 —— 全局装的、插件带来的都算，而启停不在
 * 本应用手上：那几层目录由 agent 自己按分层装载，这里给不出一个拨得动的开关。
 */
function _skillRow(entry: PaletteEntry): ContributionRow {
  return {
    key: entry.name,
    title: entry.label,
    detail: entry.description === '' ? '这个技能没有写说明。' : entry.description,
    badge: 'agent 报来',
  }
}

/*
 * enabled 是这一台自己的开关，launchedBy 是「这一次谁会起它」。两个都要显示：插件整体关掉
 * 时这一台的开关不该被悄悄拨回去，但也不能让人以为它还在跑。
 *
 * mcp.json 里那些的开关与移除落回文件本身：enabled 与 CLI 拨的是同一格（缺席即开，
 * 官方语义），两边看到的永远是同一个答案。
 */
function serverRow(server: ResolvedMcpServer, store: PluginStore): ContributionRow {
  const { origin } = server

  const toggle = (
    <Switch
      aria-label={`启用 ${server.name}`}
      checked={server.enabled}
      onCheckedChange={(next) => store.setMcpServerEnabled(origin, server.name, next)}
      size="sm"
    />
  )

  if (origin.kind === 'user') {
    return {
      key: `${origin.location}/${server.name}`,
      title: server.name,
      detail: `${origin.location} · ${server.enabled ? '会话开始时由命令行装载' : '已在配置里关闭'}`,
      badge: describeOrigin(origin),
      dimmed: !server.enabled,
      trailing: (
        <>
          <Button
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => store.removeEnvironmentServer(server.name)}
            size="xs"
            variant="ghost"
          >
            移除
          </Button>
          {toggle}
        </>
      ),
    }
  }

  return {
    key: `${describeOrigin(origin)}/${server.name}`,
    title: server.name,
    detail: detailOf(origin, server),
    badge: describeOrigin(origin),
    dimmed: !server.enabled,
    trailing: toggle,
  }
}

/*
 * 开着却不会装载只有一个原因：带来它的插件整体被关掉了。说出来，人才知道该去拨哪个开关。
 */
function detailOf(origin: ContributionOrigin, server: ResolvedMcpServer): string {
  if (!server.enabled) {
    return '已关闭'
  }

  if (server.launchedBy === 'agent') {
    return '会话开始时由命令行装载'
  }

  return origin.kind === 'plugin' ? '插件已关闭，这一台不会装载' : 'mcp.json 里这一条被关掉了'
}
