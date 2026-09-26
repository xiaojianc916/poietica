import { ErrorState, LoadingState, Select, type SelectOption } from '@poietica/design-system'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AgentSettingEntry, AgentSettingsStore } from '../../index'
import { SettingRow, SettingsGroup, SettingsPage } from '../settings-primitives'
import { SettingControl } from './setting-control'
import { isVisible, settingLookup } from './settings-conditions'
import './agent-settings.css'

/*
 * agent 自己那份设置目录。整页由它自报的元数据生成：栏与节的划分、每一格的文案、控件与
 * 选项表都从目录里读，这里没有一行 per-setting 的表单代码，也没有一份抄来的文案
 * （ADR 0054 决定四）。
 *
 * 分组是「栏 → 节」两级：栏来自桥交回的 `tabs`（agent 自己的词汇与顺序），节来自每格的
 * `group`。**不硬编码栏名**：抄一份就是第二个事实，上游加一栏我们静默落后（AGENTS.md §0）。
 */

export interface AgentSettingsCatalogProps {
  readonly store: AgentSettingsStore
}

export function AgentSettingsCatalog({ store }: AgentSettingsCatalogProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [selected, setSelected] = useState<string | null>(null)

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
      catalog.settings.some((entry) => entry.tab === tab && isVisible(entry, at)),
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

  const current = selected !== null && tabs.includes(selected) ? selected : (tabs[0] ?? '')

  return (
    <SettingsPage>
      {snapshot.error === null ? null : (
        <p className="settings-error" role="alert">
          {snapshot.error}
        </p>
      )}

      <SettingsGroup
        headerAction={
          tabs.length < 2 ? undefined : (
            <Select
              align="end"
              className="settings-select-trigger"
              data={tabs.map((tab) => ({ value: tab, label: tab })) satisfies SelectOption[]}
              onValueChange={setSelected}
              type="设置栏目"
              value={current}
            />
          )
        }
        title="栏目"
      >
        <SettingRow
          description="文案与选项都是 agent 自己报的；改完由它自己热重载，不用重启，也不动它的配置文件"
          label="来源"
        />
      </SettingsGroup>

      <TabSettings
        entries={settings.filter((entry) => entry.tab === current)}
        onWrite={(path, value) => void store.write(path, value)}
        saving={snapshot.saving}
        settings={settings}
      />
    </SettingsPage>
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

    for (const entry of entries) {
      if (!isVisible(entry, at)) {
        continue
      }

      const name = entry.group ?? ''
      if (!byGroup.has(name)) {
        order.push(name)
        byGroup.set(name, [])
      }
      byGroup.get(name)?.push(entry)
    }

    return order.map((name) => ({ name, items: byGroup.get(name) ?? [] }))
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
          title={group.name === '' ? undefined : group.name}
        >
          {group.items.map((entry) => (
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
        </SettingsGroup>
      ))}
    </>
  )
}
