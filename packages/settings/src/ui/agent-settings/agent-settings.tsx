import {
  Button,
  ErrorState,
  LoadingState,
  Select,
  type SelectOption,
} from '@poietica/design-system'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
  AgentSettingEntry,
  AgentSettingSection,
  AgentSettingsStore,
  AgentSettingTab,
} from '../../index'
import { SettingRow, SettingsGroup, SettingsPage } from '../settings-primitives'
import { CatalogRows, mainCatalogEntries, sectionEntries } from './catalog-rows'
import './agent-settings.css'

/*
 * agent 自己那份设置目录。整页由它自报的元数据生成：栏、节、文案、控件与选项表都从目录里读，
 * 这里没有一行 per-setting 的表单代码（ADR 0018 决定四）。
 *
 * 栏来自桥交回的 `tabs`，节来自每格的 `group`；两者都不硬编码 —— 抄一份就是第二个事实。
 *
 * 归属别的页面的格子（`section`）在这里一格都不画：同一件事两页各一个控件就是缺陷（AGENTS.md §1）。
 */

export function AgentSettingsCatalog({ store }: { readonly store: AgentSettingsStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void store.load()
  }, [store])

  const catalog = snapshot.catalog
  const settings = catalog?.settings

  /* 只留画得出来的栏：某一栏整栏被条件或归属挡掉时，不留一个点进去空白的入口。 */
  const tabs = useMemo(() => {
    if (catalog === null) {
      return []
    }

    const drawable = mainCatalogEntries(catalog.settings)

    return catalog.tabs.filter((tab) => drawable.some((entry) => entry.tab === tab.key))
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

  /* 搜索时跨栏找：人不记得那项设置在哪一栏，只记得它叫什么。 */
  const searching = query.trim() !== ''
  const needle = query.trim().toLowerCase()
  const current = currentTab(selected, tabs)
  const main = mainCatalogEntries(settings)
  /* mainCatalogEntries 已滤过归属、owned 与条件，这里只选段：搜索命中，或当前那一栏。 */
  const matched = searching
    ? main.filter((entry) => matches(entry, needle))
    : main.filter((entry) => entry.tab === current?.key)

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
        <EmptyNotice
          description={
            searching
              ? '换个词试试，也可以搜 omp 的原路径（如 lsp.）'
              : '当前条件下这一栏没有可改的设置'
          }
          label={searching ? '没有匹配的设置' : '无可显示的项'}
        />
      ) : (
        <CatalogRows
          entries={matched}
          onWrite={(path, value) => void store.write(path, value)}
          saving={snapshot.saving}
        />
      )}
    </SettingsPage>
  )
}

/*
 * 记忆与人设与风格两页：同一份目录里取归属自己的一段。两页只差 `section`，所以只有一份实现。
 *
 * 空态是防御性的：上游此刻给这两栏 30 / 17 格，正常取不到空。留着它是因为「取到空」与
 * 「目录还没读到」是两件事，合成一个加载态会让人以为设置丢了。
 */
export function AgentSettingsSectionPage({
  store,
  section,
}: {
  readonly store: AgentSettingsStore
  readonly section: AgentSettingSection
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(() => {
    void store.load()
  }, [store])

  const settings = snapshot.catalog?.settings

  return (
    <SettingsPage>
      {snapshot.error === null ? null : (
        <p className="settings-error" role="alert">
          {snapshot.error}
        </p>
      )}

      {settings === undefined ? (
        <div className="settings-state">
          {snapshot.error === null ? (
            <LoadingState label="正在读取 agent 自己的设置…" />
          ) : (
            <ErrorState message={snapshot.error} onRetry={() => void store.refresh()} />
          )}
        </div>
      ) : (
        <SectionRows
          entries={sectionEntries(settings, section)}
          onWrite={(path, value) => void store.write(path, value)}
          saving={snapshot.saving}
        />
      )}
    </SettingsPage>
  )
}

/* 空态说清此刻为什么没有可改的，而不是一个光秃秃的标题。 */
function EmptyNotice({
  label,
  description,
}: {
  readonly label: string
  readonly description: string
}) {
  return (
    <SettingsGroup>
      <SettingRow description={description} label={label} />
    </SettingsGroup>
  )
}

function SectionRows({
  entries,
  onWrite,
  saving,
}: {
  readonly entries: readonly AgentSettingEntry[]
  readonly onWrite: (path: string, value: unknown) => void
  readonly saving: string | null
}) {
  if (entries.length === 0) {
    return <EmptyNotice description="agent 没有报出这一类设置" label="无可显示的项" />
  }

  return <CatalogRows entries={entries} onWrite={onWrite} saving={saving} />
}

function currentTab(
  selected: string | null,
  tabs: readonly AgentSettingTab[],
): AgentSettingTab | undefined {
  return tabs.find((tab) => tab.key === selected) ?? tabs[0]
}

/* 命中名称、路径、分组或说明：人会记得那个功能的路径（lsp.）或一句描述，而不是它的标题。 */
function matches(entry: AgentSettingEntry, needle: string): boolean {
  return (
    entry.label.toLowerCase().includes(needle) ||
    entry.path.toLowerCase().includes(needle) ||
    (entry.group?.toLowerCase().includes(needle) ?? false) ||
    entry.description.toLowerCase().includes(needle)
  )
}
