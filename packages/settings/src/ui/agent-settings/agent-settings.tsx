import {
  Button,
  ErrorState,
  LoadingState,
  Select,
  type SelectOption,
} from '@poietica/design-system'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AgentSettingEntry, AgentSettingsStore, AgentSettingTab } from '../../index'
import { SettingRow, SettingsGroup, SettingsPage } from '../settings-primitives'
import { SettingControl } from './setting-control'
import { isVisible, settingLookup } from './settings-conditions'
import './agent-settings.css'

/*
 * agent 自己那份设置目录。整页由它自报的元数据生成：栏与节的划分、每一格的文案、控件与
 * 选项表都从目录里读，这里没有一行 per-setting 的表单代码（ADR 0054 决定四）。
 *
 * 分组是「栏 → 节」两级：栏来自桥交回的 `tabs`（agent 自己的词汇与顺序），节来自每格的
 * `group`。**不硬编码栏名**：抄一份就是第二个事实，上游加一栏我们静默落后（AGENTS.md §0）。
 *
 * 几百项设置这一页要能用，靠三件事，缺一样都变成一片翻不完的墙：
 *   1. 搜索：378 项没有搜索就只能靠翻。
 *   2. 收起终端专属的那些：agent 是终端程序，它的主题/状态行/字形在这里改了看不见效果。
 *   3. 直接改它自己的配置文件：懂的人不必跟 378 个控件打交道。
 */

export interface AgentSettingsCatalogProps {
  readonly store: AgentSettingsStore
}

export function AgentSettingsCatalog({ store }: AgentSettingsCatalogProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void store.load()
  }, [store])

  const catalog = snapshot.catalog
  const settings = catalog?.settings

  /*
   * 只留画得出来的栏：某一栏的格子全被条件挡住时，导航里不留一个点进去空白的入口。
   * 与条件本身同一个降级方向 —— 少显示一格人看得出，点进去一片空白是人看不出哪里错了。
   */
  const tabs = useMemo(() => {
    if (catalog === null) {
      return []
    }

    const at = settingLookup(catalog.settings)

    return catalog.tabs.filter((tab) =>
      catalog.settings.some(
        (entry) => entry.tab === tab.key && entry.owned !== true && isVisible(entry, at),
      ),
    )
  }, [catalog])

  if (settings === undefined) {
    return (
      <SettingsPage>
        {snapshot.error === null ? (
          <div className="settings-state">
            <LoadingState label="正在读取 agent 自己的设置…" />
          </div>
        ) : (
          <ErrorState message={snapshot.error} onRetry={() => void store.refresh()} />
        )}
      </SettingsPage>
    )
  }

  /*
   * 搜索时跨栏找：找一项设置的人不记得它在哪一栏，只记得它叫什么。
   * 没搜索词就按栏看，那是「浏览」这一种用法。
   */
  const searching = query.trim() !== ''
  const needle = query.trim().toLowerCase()
  const current = currentTab(selected, tabs)
  /*
   * 搜索也跳过 `owned`：搜得到却画不出来，比搜不到更让人以为漏了东西。
   * 那些格子在输入框那一排或「电脑控制」一节里，人要去那里改。
   */
  const matched = (
    searching
      ? settings.filter((entry) => matches(entry, needle))
      : settings.filter((entry) => entry.tab === current?.key)
  ).filter((entry) => entry.owned !== true)

  return (
    <SettingsPage>
      {snapshot.error === null ? null : (
        <p className="settings-error" role="alert">
          {snapshot.error}
        </p>
      )}

      <SettingsGroup
        headerAction={
          tabs.length < 2 || searching ? undefined : (
            <Select
              align="end"
              className="settings-select-trigger"
              data={
                tabs.map((tab) => ({ value: tab.key, label: tab.label })) satisfies SelectOption[]
              }
              onValueChange={setSelected}
              type="设置栏目"
              value={current?.key ?? ''}
            />
          )
        }
        title="栏目"
      >
        <SettingRow
          description="文案与选项都是 agent 自己报的；改完由它自己热重载，不用重启"
          label="来源"
        >
          <label className="settings-input settings-input--with-icon agent-settings__search">
            <Search aria-hidden="true" />
            <input
              aria-label="搜索设置"
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              placeholder="按名称或路径搜索…"
              value={query}
            />
          </label>
        </SettingRow>

        {catalog === null ? null : (
          <SettingRow
            description={catalog.configFile}
            label={catalog.configFileExists ? '用编辑器改配置文件' : '配置文件还没生成'}
          >
            <Button
              disabled={!catalog.configFileExists}
              onClick={() => {
                void store.openConfigFile()
              }}
              size="sm"
              variant="outline"
            >
              打开
            </Button>
          </SettingRow>
        )}
      </SettingsGroup>

      {matched.length === 0 ? (
        <SettingsGroup>
          <SettingRow
            description={
              searching
                ? '换个词试试，也可以搜 omp 的原路径（如 lsp.）'
                : '当前条件下这一栏没有可改的设置'
            }
            label={searching ? '没有匹配的设置' : '无可显示的项'}
          />
        </SettingsGroup>
      ) : (
        <TabSettings
          entries={matched}
          onWrite={(path, value) => void store.write(path, value)}
          saving={snapshot.saving}
          settings={settings}
        />
      )}
    </SettingsPage>
  )
}

function currentTab(
  selected: string | null,
  tabs: readonly AgentSettingTab[],
): AgentSettingTab | undefined {
  return tabs.find((tab) => tab.key === selected) ?? tabs[0]
}

/*
 * 命中：名称、路径、分组、说明，四处任一处含这个词就算。
 *
 * 路径也搜是因为「我知道它叫 lsp.，但不知道中文叫什么」是常见的一半；说明也搜是因为
 * 人会记得一句描述而记不住名字。
 */
function matches(entry: AgentSettingEntry, needle: string): boolean {
  return (
    entry.label.toLowerCase().includes(needle) ||
    entry.path.toLowerCase().includes(needle) ||
    (entry.group?.toLowerCase().includes(needle) ?? false) ||
    entry.description.toLowerCase().includes(needle)
  )
}

interface TabSettingsProps {
  readonly entries: readonly AgentSettingEntry[]
  readonly settings: readonly AgentSettingEntry[]
  readonly saving: string | null
  readonly onWrite: (path: string, value: unknown) => void
}

function TabSettings({ entries, settings, saving, onWrite }: TabSettingsProps) {
  const at = useMemo(() => settingLookup(settings), [settings])

  /* 条件在同一份目录里求值一次：同一格的条件不会在读到下一份目录之前变。 */
  const groups = useMemo(() => {
    const order: string[] = []
    const byGroup = new Map<string, AgentSettingEntry[]>()
    /*
     * 分组认 agent 自己的 `group`（键），标题用 `groupLabel`（名）。
     *
     * 键不能译：译了以后「Magic Keywords」与它自己就变成两节。名只取一次 —— 同一节里
     * 每一格报的名本该相同，取第一格就够。
     */
    const titles = new Map<string, string>()

    for (const entry of entries) {
      /*
       * 已有专属控件的行不画第二遍（`owned`）：计划/目标/思考档位/审批在输入框那一排就有
       * 选择器，浏览器那三格在「电脑控制」一节里。一个事实两个控件是缺陷（AGENTS.md §1）——
       * 两个控件改同一件事，改一个另一个不同步，人也不知道哪个算数。
       *
       * 它的**值**仍在 `settings` 里，所以别的格子按 `condition` 读它照常求值。
       */
      if (entry.owned === true || !isVisible(entry, at)) {
        continue
      }

      const name = entry.group ?? ''
      if (!byGroup.has(name)) {
        order.push(name)
        byGroup.set(name, [])
        titles.set(name, entry.groupLabel ?? name)
      }
      byGroup.get(name)?.push(entry)
    }

    return order.map((name) => ({
      name,
      title: titles.get(name) ?? name,
      items: byGroup.get(name) ?? [],
    }))
  }, [at, entries])

  if (groups.length === 0) {
    return (
      <SettingsGroup>
        <SettingRow description="当前条件下这一栏没有可改的设置" label="无可显示的项" />
      </SettingsGroup>
    )
  }

  return (
    <>
      {groups.map((group) => (
        <SettingsGroup
          key={group.name === '' ? '__ungrouped' : group.name}
          title={group.name === '' ? undefined : group.title}
        >
          <Rows entries={group.items} onWrite={onWrite} saving={saving} />
        </SettingsGroup>
      ))}
    </>
  )
}

interface RowsProps {
  readonly entries: readonly AgentSettingEntry[]
  readonly saving: string | null
  readonly onWrite: (path: string, value: unknown) => void
}

function Rows({ entries, onWrite, saving }: RowsProps) {
  return (
    <>
      {entries.map((entry) => (
        /*
         * 风险警示原样交给行去排在说明之上（ADR 0054 决定四）。不翻译也不改语气：
         * 措辞是上游替自己的行为负责的那一句，改一个字就是我们替它许诺。
         */
        <SettingRow
          description={entry.description}
          key={entry.path}
          label={entry.label}
          warning={entry.warning}
        >
          <SettingControl
            entry={entry}
            onChange={(value) => {
              onWrite(entry.path, value)
            }}
            saving={saving === entry.path}
          />
        </SettingRow>
      ))}
    </>
  )
}
