import { Pencil, Trash2 } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { KeybindingCatalog, KeybindingEntry } from '../index'
import { SettingsPage } from './surface/settings-primitives'

export interface KeymapSettingsProps {
  readonly catalog: KeybindingCatalog
}

/*
 * 快捷键页：搜索 + 可编辑列表。
 *
 * 编辑 / 删除是纯 UI 占位：状态留在组件本地，不写回命令注册表。
 * 后端接入时把 setRows 换成真实的持久化调用即可。
 *
 * 每行右侧是一个绑定列表：每个绑定自带编辑与删除；未分配的命令只显示
 * 「未分配」+ 编辑入口。编辑态把胶囊换成「按下快捷键」输入框 + 取消。
 */
export function KeymapSettings({ catalog }: KeymapSettingsProps) {
  const entries = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)

  const [rows, setRows] = useState<readonly KeybindingEntry[]>(entries)
  useEffect(() => {
    setRows(entries)
  }, [entries])

  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)

  /* 正在编辑的绑定：entryId + 绑定索引，-1 表示未分配命令的新增。 */
  const [editing, setEditing] = useState<{
    readonly entryId: string
    readonly index: number
  } | null>(null)

  const visible = useMemo(() => filterRows(rows, deferredQuery), [deferredQuery, rows])

  const removeBinding = (entryId: string, index: number) => {
    setRows((current) =>
      current.map((row) =>
        row.id === entryId
          ? { ...row, shortcuts: row.shortcuts.filter((_, i) => i !== index) }
          : row,
      ),
    )
  }

  return (
    <SettingsPage>
      <div className="settings-filter">
        <input
          aria-label="搜索快捷键"
          className="settings-input"
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          placeholder="搜索命令或按键"
          type="search"
          value={query}
        />
      </div>

      {visible.length === 0 ? (
        <p className="settings-placeholder">没有匹配的快捷键。</p>
      ) : (
        <div className="settings-keymap-list">
          {visible.map((entry) => (
            <KeymapRow
              editing={editing?.entryId === entry.id ? editing.index : null}
              entry={entry}
              key={entry.id}
              onCancelEdit={() => setEditing(null)}
              onDelete={removeBinding}
              onStartEdit={(index) => setEditing({ entryId: entry.id, index })}
            />
          ))}
        </div>
      )}
    </SettingsPage>
  )
}

interface KeymapRowProps {
  readonly entry: KeybindingEntry
  readonly editing: number | null
  readonly onStartEdit: (index: number) => void
  readonly onCancelEdit: () => void
  readonly onDelete: (entryId: string, index: number) => void
}

function KeymapRow({ entry, editing, onStartEdit, onCancelEdit, onDelete }: KeymapRowProps) {
  const hasBindings = entry.shortcuts.length > 0

  return (
    <div className="settings-keymap-row">
      <div className="settings-keymap-row__copy">
        <strong>{entry.label}</strong>
        {entry.description ? <p>{entry.description}</p> : null}
      </div>

      <div className="settings-keymap-row__bindings">
        {hasBindings ? (
          entry.shortcuts.map((shortcut, index) =>
            editing === index ? (
              <BindingEditor key={`${entry.id}-editing`} onCancel={onCancelEdit} />
            ) : (
              <div className="settings-keymap-binding" key={shortcut}>
                <kbd className="settings-keymap-binding__key">{shortcut}</kbd>
                <button
                  aria-label={`编辑 ${entry.label} 的快捷键`}
                  className="settings-keymap-binding__icon"
                  onClick={() => onStartEdit(index)}
                  type="button"
                >
                  <Pencil size={14} strokeWidth={1.7} />
                </button>
                <button
                  aria-label={`删除 ${entry.label} 的快捷键`}
                  className="settings-keymap-binding__icon"
                  onClick={() => onDelete(entry.id, index)}
                  type="button"
                >
                  <Trash2 size={14} strokeWidth={1.7} />
                </button>
              </div>
            ),
          )
        ) : editing === -1 ? (
          <BindingEditor onCancel={onCancelEdit} />
        ) : (
          <div className="settings-keymap-binding">
            <span className="settings-keymap-binding__unassigned">未分配</span>
            <button
              aria-label={`为 ${entry.label} 添加快捷键`}
              className="settings-keymap-binding__icon"
              onClick={() => onStartEdit(-1)}
              type="button"
            >
              <Pencil size={14} strokeWidth={1.7} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function BindingEditor({ onCancel }: { readonly onCancel: () => void }) {
  return (
    <div className="settings-keymap-binding">
      <input
        aria-label="按下快捷键"
        className="settings-keymap-binding__input"
        placeholder="按下快捷键"
        readOnly
        type="text"
      />
      <button className="settings-keymap-binding__cancel" onClick={onCancel} type="button">
        取消
      </button>
    </div>
  )
}

/*
 * 顺序跟着目录给的顺序走，不另排一次序。
 *
 * 目录的顺序就是命令注册的顺序，而注册顺序是组合根里那张表决定的产品顺序；在
 * 这里按字典序再排一遍，等于给"命令怎么排"造第二个来源。
 *
 * 按键也参与匹配，而且匹配的是屏幕上那一串（'Ctrl+K'）：用户搜的是他看见的
 * 东西，不是逻辑写法 'Mod+K'。
 */
function filterRows(
  entries: readonly KeybindingEntry[],
  query: string,
): readonly KeybindingEntry[] {
  const needle = query.trim().toLocaleLowerCase()

  if (needle === '') {
    return entries
  }

  return entries.filter((entry) =>
    `${entry.label} ${entry.description ?? ''} ${entry.shortcuts.join(' ')}`
      .toLocaleLowerCase()
      .includes(needle),
  )
}
