import { useMemo } from 'react'
import type { AgentSettingEntry, AgentSettingSection } from '../../index'
import { SettingRow, SettingsGroup } from '../settings-primitives'
import { SettingControl } from './setting-control'
import { isVisible, settingLookup } from './settings-conditions'

/*
 * agent 自报目录的画法：按 group 分成若干节，每节画「行 + 控件」。
 *
 * 分组认 agent 自己的 `group`（键），标题用 `groupLabel`（名）：键不能译，译了同一节会裂成两节。
 */

export interface CatalogRowsProps {
  readonly entries: readonly AgentSettingEntry[]
  readonly onWrite: (path: string, value: unknown) => void
  /** 正在写的那一格的路径；缺席即没有在写。 */
  readonly saving: string | null
}

export function CatalogRows({ entries, onWrite, saving }: CatalogRowsProps) {
  const groups = useMemo(() => groupBy(entries), [entries])

  return (
    <>
      {groups.map((group) => (
        <SettingsGroup key={group.name === '' ? '__ungrouped' : group.name} title={group.title}>
          {group.items.map((entry) => (
            /*
             * 风险警示原样交给行去排在说明之上（ADR 0018 决定四）。不翻译也不改语气：
             * 措辞是上游替自己的行为负责的那一句。
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

interface CatalogGroup {
  /** 分节的键；空串是「没有 group」那一节。 */
  readonly name: string
  readonly title: string
  readonly items: readonly AgentSettingEntry[]
}

function groupBy(entries: readonly AgentSettingEntry[]): readonly CatalogGroup[] {
  const order: string[] = []
  const byGroup = new Map<string, AgentSettingEntry[]>()
  const titles = new Map<string, string>()

  for (const entry of entries) {
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
}

/*
 * 取一页要画的那一段，并滤掉两类不画的格子：
 *   - `owned`：行由产品别处的控件负责（画第二遍就是一个事实两个控件）。值仍留着，别的格子按 `condition` 读它。
 *   - 条件不成立的：判据要用**别的格子**的值，所以收的是整份目录而不是筛完的那一段。
 *
 * 归属（`section`）不在这里判，由下面两个入口各判各的。
 */
function visibleEntries(
  settings: readonly AgentSettingEntry[],
  keep: (entry: AgentSettingEntry) => boolean,
): readonly AgentSettingEntry[] {
  const at = settingLookup([...settings])

  return settings.filter((entry) => keep(entry) && entry.owned !== true && isVisible(entry, at))
}

/** Agent 设置页：目录里没有归属给别的页面的那些（与 `owned` 正交）。 */
export function mainCatalogEntries(
  settings: readonly AgentSettingEntry[],
): readonly AgentSettingEntry[] {
  return visibleEntries(settings, (entry) => entry.section === undefined)
}

/** 一个剥离页：只画归属给自己的格子。 */
export function sectionEntries(
  settings: readonly AgentSettingEntry[],
  section: AgentSettingSection,
): readonly AgentSettingEntry[] {
  return visibleEntries(settings, (entry) => entry.section === section)
}
