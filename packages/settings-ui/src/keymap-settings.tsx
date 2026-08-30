import type { KeybindingCatalog, KeybindingEntry } from '@poietica/settings'
import { useDeferredValue, useMemo, useState, useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage } from './surface/settings-primitives'

export interface KeymapSettingsProps {
  readonly catalog: KeybindingCatalog
}

/*
 * 快捷键页读的是命令自己声明的那一份，不是第二张表。
 *
 * 这一页没有自己的样式表：卡片、行、分割线用的是 settings-primitives 那套排版
 * 词汇，和外观页、隐私页逐像素相同。此前它自建了一套描边卡片与键帽，等于同一
 * 个设置界面里有两种长相 —— 那正是这轮重构在收敛的那类问题。
 *
 * 不分类：分类的用途是在长列表里定位，而这一页顶上就是搜索框，两者解决同一个
 * 问题。命令面板需要分组，是因为它没有筛选之外的第二种导航方式。
 *
 * 还不可改写，所以这里不放输入框假装能改：一个拨得动却存不下的绑定比一句实话
 * 有害得多。可改写要先有冲突检测与持久化，那是下一批的事。
 */
export function KeymapSettings({ catalog }: KeymapSettingsProps) {
  const entries = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)

  const [query, setQuery] = useState('')

  /* 搜索输入不该等列表重算：延后的是结果，不是光标。 */
  const deferredQuery = useDeferredValue(query)

  const visible = useMemo(() => filterEntries(entries, deferredQuery), [deferredQuery, entries])

  return (
    <SettingsPage>
      <div className="settings-filter">
        <p>快捷键由命令自身声明，暂不可改写。</p>

        <input
          aria-label="搜索快捷键"
          className="settings-search"
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
        <SettingsGroup>
          {visible.map((entry) => (
            <SettingRow key={entry.id} label={entry.label}>
              <kbd className="settings-shortcut">{entry.shortcut}</kbd>
            </SettingRow>
          ))}
        </SettingsGroup>
      )}
    </SettingsPage>
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
function filterEntries(
  entries: readonly KeybindingEntry[],
  query: string,
): readonly KeybindingEntry[] {
  const needle = query.trim().toLocaleLowerCase()

  if (needle === '') {
    return entries
  }

  return entries.filter((entry) =>
    `${entry.label} ${entry.shortcut}`.toLocaleLowerCase().includes(needle),
  )
}
