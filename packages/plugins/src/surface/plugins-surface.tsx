import type { AgentSkill } from '@poietica/agent-contract'
import { assertUnreachable } from '@poietica/core'
import { Button, cn, Switch } from '@poietica/ui'
import { useState, useSyncExternalStore } from 'react'

import { builtinServerRows, builtinSkillRows, groupRows, matches } from '../catalog/listing'
import { latestCatalog, type MarketplaceEntry } from '../marketplace'
import type { ResolvedMcpServer } from '../mcp-servers'
import { type ContributionOrigin, describeOrigin } from '../origin'
import type { PluginStore, PluginsViewModel } from '../plugin-store'
import { type ResolvedSkill, resolveSkills } from '../skill'
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
      '工作流与提示模板，用 /skill 调用。会话里能调用的全部由 agent 报来；压暗的那几行是装了、这个会话却没装载的。',
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
  /**
   * kap 名册里的技能表：会话里能调用的全部。名册唯一持有者是能力表 store
   * （AgentCapabilityStore.toolkit），组合根经 Context 读它交进来，这里不复制。
   */
  readonly roster: readonly AgentSkill[]
  readonly store: PluginStore
}

export function PluginsSurface({ roster, store }: PluginsSurfaceProps) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [tab, setTab] = useState<TabId>('plugins')
  const [needles, setNeedles] = useState<Record<TabId, string>>(EMPTY_NEEDLES)
  const [openedId, setOpenedId] = useState<string | undefined>(undefined)

  const needle = needles[tab]
  const entries: readonly MarketplaceEntry[] = latestCatalog(view.marketplace)?.entries ?? []

  /* 名册 × 本机目录，唯一一张技能表。 */
  const skills = resolveSkills({ owned: view.ownedSkills, roster })

  const counts: Record<TabId, number> = {
    plugins: view.plugins.length,
    skills: skills.length,
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
              技能那一格没有刷新按钮：名册由 agent 推着更新，装卸落定后组合根也会让
              它重问一轮。另外两格刷的是同一份市场目录，所以它们共用这一个。
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
          skills={skills}
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
  readonly skills: readonly ResolvedSkill[]
  readonly store: PluginStore
  readonly view: PluginsViewModel
  readonly onOpen: (id: string) => void
}

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
      const rows = skills
        .filter((skill) => matches(needle, skill.name, skill.description, skill.source))
        .map((skill) => skillRow(skill, store))

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
          <Section count={rows.length} title="会话可用">
            <ContributionList
              empty="这个会话还没有技能。下面那份名单一键装，装完在新会话里用 /skill 调用。"
              rows={rows}
            />
          </Section>
          <CatalogGrid
            action={{ kind: 'skill', install: store.installSkill }}
            groups={groupRows(builtinSkillRows(view.ownedSkills, needle))}
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
 * 名册 × 本机目录合成的一行。
 *
 * 移除只长在本机装着的行上：对别的来源点移除只会「静默成功」而名册照旧 —— 没有
 * 按钮好过会说谎的按钮（与 serverRow 的 origin.kind === 'user' 同一条范式）。名册
 * 没报的那几行整行压暗：装了却没装载，第一次被说出来。
 */
function skillRow(skill: ResolvedSkill, store: PluginStore): ContributionRow {
  return {
    key: `skill/${skill.name}`,
    title: skill.name,
    detail:
      skill.description ??
      (skill.served
        ? '这个技能没有写说明。'
        : '已装在这里，但这个会话没有装载它；新开会话或让 agent 重载后再试。'),
    ...(skill.source === undefined ? {} : { badge: skill.source }),
    dimmed: !skill.served,
    trailing: skill.owned ? (
      <Button
        className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => store.removeInstalledSkill(skill.name)}
        size="xs"
        variant="ghost"
      >
        移除
      </Button>
    ) : undefined,
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
