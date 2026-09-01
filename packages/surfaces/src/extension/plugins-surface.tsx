import type { AgentSkill } from '@poietica/conversation'
import { Button, cn, Switch } from '@poietica/design-system'
import {
  builtinServerRows,
  builtinSkillRows,
  type ContributionOrigin,
  describeOrigin,
  groupRows,
  latestCatalog,
  type MarketplaceEntry,
  matches,
  type PluginStore,
  type PluginsViewModel,
  type ResolvedMcpServer,
  type SkillRow,
  skillRows,
} from '@poietica/extension'
import { assertUnreachable } from '@poietica/problem'
import { useState, useSyncExternalStore } from 'react'
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
      '这个 agent 认得的技能，用 /skill 调用。装在本机 skills/ 的可以在这里开关或移除（开关就是磁盘上改名）。',
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
   * kap 名册里的技能表：有哪些技能由它说了算，agent 自带那一层在它的持有者处已经滤掉
   * （AgentCapabilityStore.toolkit）。本机 skills/ 是其中我们写得动的那一层。
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

  /* 名册说有哪些——含本机 skills/ 那一层（directory 非空即是），直接投影。 */
  const skills = skillRows(roster)

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
  readonly skills: readonly SkillRow[]
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
        .filter((skill) => matches(needle, skill.name, skill.description, skill.directory))
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
          <Section count={rows.length} title="已安装">
            <ContributionList
              empty="这里还没有装技能。下面那份名单一键装，装完在新会话里用 /skill 调用。"
              rows={rows}
            />
          </Section>
          <CatalogGrid
            action={{ kind: 'skill', install: store.installSkill }}
            groups={groupRows(
              builtinSkillRows(
                skills.map((one) => one.name),
                needle,
              ),
            )}
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
 * 一行技能。
 *
 * 开关与移除只给本机 skills/ 里那些：SKILL.md 与 SKILL.md.disabled 之间改名，正文一个字节
 * 不动 —— 与 CLI 认的是同一个判据。别的层来的没有目录，也就没有这两个动作：那些文件不归
 * 我们改。压暗表示这个会话不会装载它。
 */
function skillRow(skill: SkillRow, store: PluginStore): ContributionRow {
  const { directory } = skill

  return {
    key: `skill/${directory ?? skill.name}`,
    title: skill.name,
    detail: skill.description ?? skillDetail(skill),
    ...(skill.source === undefined ? {} : { badge: describeSkillSource(skill.source) }),
    dimmed: !skill.enabled || !skill.loaded,
    ...(directory === undefined
      ? {}
      : {
          trailing: (
            <>
              <Button
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => store.trashInstalledSkill(directory)}
                size="xs"
                variant="ghost"
              >
                移除
              </Button>
              <Switch
                aria-label={`启用 ${skill.name}`}
                checked={skill.enabled}
                onCheckedChange={(next) => store.setSkillEnabled(directory, next)}
                size="sm"
              />
            </>
          ),
        }),
  }
}

/* 这一行为什么是灰的，或者它凭什么在这里。 */
function skillDetail(skill: SkillRow): string {
  if (!skill.enabled) {
    return '已停用：SKILL.md 已改名，会话不会装载它。'
  }

  if (skill.directory === undefined) {
    return 'agent 自己装载的，这里只列出来。'
  }

  return skill.loaded ? '这个技能没有写说明。' : '已装在这里，新开会话后可用。'
}

/* 名册报的来源层。未知取值原样报出来，不猜。 */
function describeSkillSource(source: string): string {
  switch (source) {
    case 'project':
      return '工作目录'
    case 'user':
      return '这台机器'
    case 'extra':
      return '额外目录'
    default:
      return source
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
