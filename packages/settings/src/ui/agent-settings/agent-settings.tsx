import { ErrorState, LoadingState } from '@poietica/design-system'
import { useEffect, useSyncExternalStore } from 'react'
import type { AgentSettingEntry, AgentSettingSection, AgentSettingsStore } from '../../index'
import { SettingRow, SettingsGroup, SettingsPage } from '../settings-primitives'
import { CatalogRows, sectionEntries } from './catalog-rows'

/*
 * 记忆与个性化两页：同一份目录里取归属自己的一段。两页只差 `section`，所以只有一份实现。
 *
 * 整页由 agent 自报的元数据生成：节、文案、控件与选项表都从目录里读，这里没有一行
 * per-setting 的表单代码（ADR 0018 决定四）。
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
