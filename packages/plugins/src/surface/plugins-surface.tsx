import type { PaletteEntry } from '@poietica/agent-contract'
import { assertUnreachable } from '@poietica/core'
import { Button, Switch } from '@poietica/ui'
import { useState, useSyncExternalStore } from 'react'

import { builtinServerRows, builtinSkillRows, groupRows, matches } from '../catalog/listing'
import { latestCatalog } from '../marketplace'
import type { ResolvedMcpServer } from '../mcp-servers'
import { describeOrigin, type ManagedOrigin } from '../origin'
import type { PluginStore } from '../plugin-store'
import type { InstalledSkill } from '../skill'
import { CatalogGrid } from './catalog-grid'
import { ContributionList, type ContributionRow } from './contribution-list'
import { PluginBrowser } from './plugin-browser'
import { PluginDetail } from './plugin-detail'

/*
 * 插件界面。三格：插件、技能、MCP。
 *
 * 技能与 MCP 不是两种插件 —— 插件是打包与分发单位，另外两样是它能带来的能力，所以那两格
 * 是投影，不是并列的第二套安装系统。
 *
 * 每一格自己持有搜索词。共用一个搜索词会让占位符写着「搜索技能」而值是上一格的插件关键
 * 字，技能列表因此被过滤空 —— 那是个说谎的控件。
 */

const TABS = {
  plugins: {
    label: '插件',
    title: '插件',
    subtitle: '完整扩展包：可以自带技能、MCP 服务器与斜杠命令。装上它，能力就出现在对话里。',
  },
  skills: {
    label: '技能',
    title: '技能',
    subtitle:
      '这个 agent 认得的工作流与提示模板，用 /skill: 调用。全局装的、它自带的、插件带来的都在这里，由 agent 在会话建立后报来。',
  },
  mcp: {
    label: 'MCP',
    title: 'MCP 服务器',
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
  const entries = latestCatalog(view.marketplace)?.entries ?? []
  const skills = view.palette.filter((entry) => entry.kind === 'skill')

  const counts: Record<TabId, number> = {
    plugins: view.plugins.length,
    skills: skills.length,
    mcp: view.mcpServers.length,
  }

  if (openedId !== undefined) {
    return (
      <div className="h-full overflow-y-auto bg-ground">
        <div className="mx-auto max-w-4xl px-8">
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
    <div className="h-full overflow-y-auto bg-ground">
      <div className="sticky top-0 z-10 border-b border-divider bg-ground/85 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-8 py-3">
          {TAB_ORDER.map((one) => (
            <button
              aria-selected={one === tab}
              className={
                one === tab
                  ? 'rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground'
                  : 'rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
              }
              key={one}
              onClick={() => setTab(one)}
              role="tab"
              type="button"
            >
              {TABS[one].label}
              <span className="pl-1.5 tabular-nums opacity-60">{counts[one]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="mx-auto max-w-4xl px-8 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight">{TABS[tab].title}</h1>
        <p className="max-w-xl pt-2 text-xs leading-5 text-muted-foreground">
          {TABS[tab].subtitle}
        </p>
        <div className="flex items-center gap-2 pt-6">
          <input
            className="h-9 min-w-0 flex-1 rounded-lg border border-divider bg-background px-3 text-sm outline-none focus:border-foreground/25"
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
        <p className="pt-2 text-[11px] text-muted-foreground">{detectedText(view.detectedAt)}</p>
        <TabBody
          entries={entries}
          needle={needle}
          onOpen={setOpenedId}
          skills={skills}
          store={store}
          tab={tab}
          view={view}
        />
      </div>
    </div>
  )
}

/*
 * 「上次检测」这一行是快照存在的可见证据：没有它，一个从缓存里画出来的列表和一个刚探测完
 * 的列表在屏幕上一模一样，人无从判断自己看的是不是旧的。
 */
function detectedText(detectedAt: string): string {
  if (detectedAt === '') {
    return '正在探测这台机器上的扩展…'
  }

  return `上次检测 ${new Date(detectedAt).toLocaleString()}，重启后直接读这一份，不重扫。`
}

interface TabBodyProps {
  readonly tab: TabId
  readonly needle: string
  readonly skills: readonly PaletteEntry[]
  readonly entries: ReturnType<typeof latestCatalog> extends undefined
    ? never
    : readonly PluginsSurfaceCatalogEntry[]
  readonly store: PluginStore
  readonly view: ReturnType<PluginStore['getSnapshot']>
  readonly onOpen: (id: string) => void
}

type PluginsSurfaceCatalogEntry = NonNullable<ReturnType<typeof latestCatalog>>['entries'][number]

function TabBody({ entries, needle, onOpen, skills, store, tab, view }: TabBodyProps) {
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
      const managed = new Set(view.skills.map((skill) => `skill:${skill.dirName}`))

      return (
        <>
          {view.skillInstall.kind === 'staging' && (
            <p className="pt-4 text-xs text-muted-foreground">正在安装技能…</p>
          )}
          {view.skillInstall.kind === 'refused' && (
            <p className="pt-4 text-xs text-red-500">{view.skillInstall.reason}</p>
          )}
          <ContributionList
            empty="还没有探测到技能。技能由 agent 在会话建立后报来，装一个内置技能也会出现在这里。"
            rows={[
              ...view.skills.map((skill) => installedSkillRow(skill, store)),
              ...skills.filter((entry) => !managed.has(entry.name)).map(skillRow),
            ].filter((row) => matches(needle, row.title, row.detail))}
          />
          <CatalogGrid
            groups={groupRows(builtinSkillRows(view.skills, needle))}
            onInstall={store.installSkill}
            onInstallServer={undefined}
            onOpen={undefined}
          />
        </>
      )
    }
    case 'mcp':
      return (
        <>
          <ContributionList
            empty="这台机器上没有配置 MCP 服务器，插件也没有带来。"
            rows={view.mcpServers
              .map((server) => serverRow(server, store))
              .filter((row) => matches(needle, row.title, row.detail, row.badge))}
          />
          <CatalogGrid
            groups={groupRows(builtinServerRows(view.mcpServers, needle))}
            onInstall={store.beginInstall}
            onInstallServer={store.installEnvironmentServer}
            onOpen={undefined}
          />
        </>
      )
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
      <Button onClick={() => store.removeInstalledSkill(skill.dirName)} size="xs" variant="ghost">
        移除
      </Button>
    ),
  }
}

/*
 * 一行是一个技能，不是一个插件：人在这一格找的是「我能调用什么」。
 *
 * 技能行上没有开关 —— 启停不在本应用手上，它们由 agent 按自己那套目录分层装载。
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
 * enabled 是这一台自己的开关，launchedBy 是「这一次谁会起它」。两个都要显示：插件整体关掉
 * 时这一台的开关不该被悄悄拨回去，但也不能让人以为它还在跑。
 *
 * mcp.json 里那些的开关与移除落回文件本身：enabled 与 CLI 拨的是同一格（缺席即开，
 * 官方语义），两边看到的永远是同一个答案。受控 home 不生效时原生侧拒绝写入，开关会
 * 弹回 —— 拒绝的理由在日志里。
 */
function serverRow(server: ResolvedMcpServer, store: PluginStore): ContributionRow {
  const { origin } = server

  if (origin.kind === 'user') {
    const state = server.enabled ? '会话开始时由命令行装载' : '已在配置里关闭'

    return {
      key: `${origin.location}/${server.name}`,
      title: server.name,
      detail: `${origin.location} · ${state}`,
      badge: describeOrigin(origin),
      trailing: (
        <span className="flex items-center gap-2">
          <Button
            onClick={() => store.removeEnvironmentServer(server.name)}
            size="xs"
            variant="ghost"
          >
            移除
          </Button>
          <Switch
            aria-label={`启用 ${server.name}`}
            checked={server.enabled}
            onCheckedChange={(next) => store.setMcpServerEnabled(origin, server.name, next)}
            size="sm"
          />
        </span>
      ),
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
 * 开着却不会装载，两种原因完全不同：内置那台是端口没绑上，插件那台是插件整体被关掉。合并
 * 成一句「不会启动」，人就无从下手。
 */
function detailOf(origin: ManagedOrigin, server: ResolvedMcpServer): string {
  if (!server.enabled) {
    return '已关闭'
  }

  switch (server.launchedBy) {
    case 'client':
      return '会话开始时由本应用装载'
    case 'agent':
      return '会话开始时由命令行装载'
    case 'none':
      return origin.kind === 'builtin'
        ? '本机端口没能绑上，这一台不会装载'
        : '插件已关闭，这一台不会装载'
    default:
      return assertUnreachable(server.launchedBy)
  }
}
