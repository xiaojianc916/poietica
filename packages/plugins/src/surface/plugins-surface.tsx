import { assertUnreachable } from '@poietica/core'
import { Button, Switch } from '@poietica/ui'
import { useState, useSyncExternalStore } from 'react'

import type { ResolvedMcpServer, ResolvedSkill } from '../contribution'
import { latestCatalog } from '../marketplace'
import { describeOrigin, type ManagedOrigin } from '../origin'
import type { PluginStore } from '../plugin-store'
import { ContributionList, type ContributionRow } from './contribution-list'
import { PluginBrowser } from './plugin-browser'
import { PluginDetail } from './plugin-detail'

/*
 * Tool 里的插件界面。
 *
 * 三格：插件是目录与已装列表，技能与 MCP 是「已经装进来的东西按种类看一遍」。
 * 它们不是三种插件 —— 插件是打包与分发单位，技能与 MCP 服务器是它带进来的能力，
 * 所以这两格永远是插件的投影，而不是并列的第二套安装系统。
 *
 * 两格都列全部，包括关掉的：拨到关就消失、再也开不回来，那不是开关，是删除。
 */

interface PluginTab {
  readonly label: string
  readonly title: string
  readonly subtitle: string
}

const TABS = {
  plugins: {
    label: '插件',
    title: '插件',
    subtitle: '在你常用的工具中与 AI 协作。装上一个插件，它带来的能力就出现在对话里。',
  },
  skills: {
    label: '技能',
    title: '技能',
    subtitle: '通过任务专用的技能扩展 AI 的能力。目前技能都随插件一起装载。',
  },
  mcp: {
    label: 'MCP',
    title: 'MCP 服务器',
    subtitle: '对话能用到的外部工具服务器：本应用自带的，这台机器上已经配好的，加上插件带来的。',
  },
} as const satisfies Record<string, PluginTab>

type PluginTabId = keyof typeof TABS

const TAB_ORDER = Object.keys(TABS) as readonly PluginTabId[]

export interface PluginsSurfaceProps {
  readonly store: PluginStore
}

export function PluginsSurface({ store }: PluginsSurfaceProps) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [tab, setTab] = useState<PluginTabId>('plugins')
  const [needle, setNeedle] = useState('')
  const [openedId, setOpenedId] = useState<string | undefined>(undefined)

  const counts: Record<PluginTabId, number> = {
    plugins: view.plugins.length,
    skills: view.contributions.skills.length,
    mcp: view.contributions.mcpServers.length,
  }

  if (openedId !== undefined) {
    return (
      <div className="h-full overflow-y-auto bg-ground">
        <div className="mx-auto max-w-4xl px-8">
          <PluginDetail
            entry={latestCatalog(view.marketplace)?.entries.find((one) => one.id === openedId)}
            onBack={() => setOpenedId(undefined)}
            plugin={view.plugins.find((one) => one.pluginId === openedId)}
            store={store}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-ground">
      <div className="sticky top-0 z-10 border-b border-divider bg-ground/85 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-8 py-3">
          {TAB_ORDER.map((one) => (
            <button
              className={
                one === tab
                  ? 'rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground'
                  : 'rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
              }
              key={one}
              onClick={() => setTab(one)}
              type="button"
            >
              {TABS[one].label}
              <span className="pl-1.5 tabular-nums opacity-60">{counts[one]}</span>
            </button>
          ))}
          <span className="flex-1" />
          <Button onClick={() => store.refreshMarketplace()} size="xs" variant="ghost">
            刷新
          </Button>
        </div>
      </div>
      <div className="mx-auto max-w-4xl px-8 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight">{TABS[tab].title}</h1>
        <p className="max-w-xl pt-2 text-xs leading-5 text-muted-foreground">
          {TABS[tab].subtitle}
        </p>
        <input
          className="mt-6 h-9 w-full rounded-lg border border-divider bg-background px-3 text-sm outline-none focus:border-foreground/25"
          onChange={(event) => setNeedle(event.target.value)}
          placeholder={`搜索${TABS[tab].label}`}
          value={needle}
        />
        <TabBody needle={needle} onOpen={setOpenedId} store={store} tab={tab} view={view} />
      </div>
    </div>
  )
}

interface TabBodyProps {
  readonly tab: PluginTabId
  readonly needle: string
  readonly store: PluginStore
  readonly view: ReturnType<PluginStore['getSnapshot']>
  readonly onOpen: (id: string) => void
}

function TabBody({ needle, onOpen, store, tab, view }: TabBodyProps) {
  const keep = (row: ContributionRow): boolean =>
    needle === '' ||
    `${row.title}${row.detail}${row.badge}`.toLowerCase().includes(needle.toLowerCase())

  switch (tab) {
    case 'plugins':
      return (
        <PluginBrowser
          install={view.install}
          loaded={view.loaded}
          marketplace={view.marketplace}
          needle={needle}
          onOpen={onOpen}
          plugins={view.plugins}
          store={store}
        />
      )
    case 'skills':
      return (
        <ContributionList
          empty="还没有插件带来技能。"
          rows={view.contributions.skills.map((entry) => skillRow(entry, store)).filter(keep)}
        />
      )
    case 'mcp':
      return (
        <ContributionList
          empty="这台机器上没有配置 MCP 服务器，插件也没有带来。"
          rows={view.contributions.mcpServers
            .map((server) => serverRow(server, store))
            .filter(keep)}
        />
      )
    default:
      return assertUnreachable(tab)
  }
}

/*
 * 一行是一个技能，不是一个插件。
 *
 * 人在这一格找的是「我能调用什么」，所以主标题是调用式。一个插件带来五个技能时，五行
 * 同名的插件名说不出任何一个能怎么用。
 *
 * 开关落在插件上：官方没有「单独关掉一个技能」这一格，能拨的最小单位就是插件。
 */
function skillRow(entry: ResolvedSkill, store: PluginStore): ContributionRow {
  const { skill } = entry

  return {
    key: `${skill.pluginId}/${skill.path}`,
    title: skill.invocation,
    detail: skill.modelInvocable ? skill.description : `${skill.description} · 只能手动调用`,
    badge: skill.pluginId,
    trailing: (
      <Switch
        aria-label={`启用 ${skill.pluginId} 的技能`}
        checked={entry.enabled}
        onCheckedChange={(next) => store.setEnabled(skill.pluginId, next)}
        size="sm"
      />
    ),
  }
}

/*
 * enabled 是这一台自己的开关，active 是「本应用会在会话开始时启动它」。两个都要
 * 显示：插件整体关掉时这一台的开关不该被悄悄拨回去，但也不能让人以为它还在跑。
 *
 * 机器上那份 mcp.json 里的没有开关。那份文件不归本应用所有 —— 从这里改掉它，等于
 * 让人下次在终端里跑 CLI 时莫名其妙地换了一套服务器。它们只显示，并且明说是谁在管。
 */
function serverRow(server: ResolvedMcpServer, store: PluginStore): ContributionRow {
  const { origin } = server

  if (origin.kind === 'user') {
    return {
      key: `${origin.location}/${server.name}`,
      title: server.name,
      detail:
        server.wire === undefined
          ? `${origin.location} · 传输方式无法识别`
          : `${origin.location} · ${server.enabled ? '由这台机器上的 CLI 装载' : '已在配置里关闭'}`,
      badge: describeOrigin(origin),
    }
  }

  return {
    key: `${describeOrigin(origin)}/${server.name}`,
    title: server.name,
    detail: detailOf(origin, server),
    badge: describeOrigin(origin),
    trailing: (
      <Switch
        aria-label={`启用 ${server.name}`}
        checked={server.enabled}
        onCheckedChange={(next) => store.setMcpServerEnabled(origin, server.name, next)}
        size="sm"
      />
    ),
  }
}

/*
 * 开着却不会装载，两种原因完全不同：内置那台是端口没绑上，插件那台是插件整体被关掉。
 * 合并成一句「不会启动」，人就无从下手 —— 一个该去看端口，一个该去把插件打开。
 */
function detailOf(origin: ManagedOrigin, server: ResolvedMcpServer): string {
  if (!server.enabled) {
    return '已关闭'
  }

  if (server.active) {
    return '会话开始时装载'
  }

  return origin.kind === 'builtin'
    ? '本机端口没能绑上，这一台不会装载'
    : '插件已关闭，这一台不会装载'
}
