import type { PaletteEntry } from '@poietica/agent-contract'
import { assertUnreachable } from '@poietica/core'
import { Button, Switch } from '@poietica/ui'
import { useState, useSyncExternalStore } from 'react'

import type { ResolvedMcpServer } from '../contribution'
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
    subtitle: '这个 agent 现在认得的技能：全局装的、它自己带的，加上插件带来的。',
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
    skills: skillsOf(view.palette).length,
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
          empty="这个 agent 还没有报来任何技能。"
          rows={skillsOf(view.palette).map(skillRow).filter(keep)}
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
/*
 * 表里属于技能的那些，顺序原样保留。
 *
 * 顺序是 agent 报的顺序，也就是人在对话里敲斜杠时看到的顺序 —— 两处读的是同一张
 * 表，所以两处不可能对不上。
 */
function skillsOf(palette: readonly PaletteEntry[]): readonly PaletteEntry[] {
  return palette.filter((entry) => entry.kind === 'skill')
}

/*
 * 技能行上没有开关。
 *
 * 技能的启停不在本应用手上：它们由 agent 按自己那套目录分层装载，关掉一条要改的是
 * 那份目录或者 agent 自己的配置。此前这里画着一个开关，标签写"启用某插件的技能"，
 * 而它拨的是整个插件 —— 点一下会连带停掉那个插件的 MCP 服务器和系统提示词。一个
 * 说谎的控件比没有控件坏。
 */
function skillRow(entry: PaletteEntry): ContributionRow {
  return {
    key: entry.name,
    title: entry.label,
    detail: entry.description === '' ? '这个技能没有写说明。' : entry.description,
    badge: '技能',
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
