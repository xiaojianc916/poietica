import { useDeferredValue, useMemo, useState, useSyncExternalStore } from 'react'
import { SettingsPage } from '../surface/settings-primitives'
import type { KeybindingCatalog, KeybindingEntry } from './keybinding-catalog'
import './keymap-settings.css'

export interface KeymapSettingsProps {
  readonly catalog: KeybindingCatalog
}

/*
 * 快捷键页读的是命令自己声明的那一份，不是第二张表。
 *
 * 此前这一页是一句"当前生效的绑定可在命令面板中查看" —— 把自己拥有的事实推给
 * 另一个界面。专业软件的设置面板在这一页给出的是完整清单，Codex / VS Code /
 * JetBrains 都是这个形态：分类分组、可搜索、键帽按平台渲染。
 *
 * 还不可改写，所以这里不放输入框假装能改：一个拨得动却存不下的绑定比一句实话
 * 有害得多。可改写要先有冲突检测与持久化，那是下一批的事。
 */
export function KeymapSettings({ catalog }: KeymapSettingsProps) {
  const entries = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)

  const [query, setQuery] = useState('')

  /* 搜索输入不该等分组重算：延后的是结果，不是光标。 */
  const deferredQuery = useDeferredValue(query)

  const groups = useMemo(() => groupByCategory(entries, deferredQuery), [deferredQuery, entries])

  return (
    <SettingsPage>
      <p className="keymap-note">快捷键由命令自身声明，暂不可改写。</p>

      <input
        aria-label="搜索快捷键"
        className="keymap-search"
        onChange={(event) => {
          setQuery(event.target.value)
        }}
        placeholder="搜索命令或按键"
        type="search"
        value={query}
      />

      {groups.length === 0 ? (
        <p className="keymap-empty">没有匹配的快捷键。</p>
      ) : (
        groups.map((group) => (
          <section className="keymap-group" key={group.category}>
            <h3 className="keymap-group__label">{group.category}</h3>

            <div className="keymap-card">
              {group.entries.map((entry) => (
                <div className="keymap-row" key={entry.id}>
                  <span className="keymap-row__name">{entry.label}</span>

                  <span className="keymap-row__keys">
                    {entry.keys.map((key) => (
                      <kbd className="keymap-key" key={key}>
                        {key}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </SettingsPage>
  )
}

interface KeybindingGroup {
  readonly category: string
  readonly entries: readonly KeybindingEntry[]
}

/*
 * 分组顺序跟着目录给的顺序走，不另排一次序。
 *
 * 目录的顺序就是命令注册的顺序，而注册顺序是组合根决定的产品顺序；在这里按字典
 * 序再排一遍，等于给"分类怎么排"造第二个来源。
 */
function groupByCategory(
  entries: readonly KeybindingEntry[],
  query: string,
): readonly KeybindingGroup[] {
  const needle = query.trim().toLowerCase()
  const groups = new Map<string, KeybindingEntry[]>()

  for (const entry of entries) {
    if (needle !== '' && !matches(entry, needle)) {
      continue
    }

    const bucket = groups.get(entry.category)

    if (bucket === undefined) {
      groups.set(entry.category, [entry])
      continue
    }

    bucket.push(entry)
  }

  return [...groups].map(([category, items]) => ({ category, entries: items }))
}

function matches(entry: KeybindingEntry, needle: string): boolean {
  return (
    entry.label.toLowerCase().includes(needle) ||
    entry.keys.some((key) => key.toLowerCase().includes(needle))
  )
}
