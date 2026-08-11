import './slash-menu.css'

import type { PaletteEntry } from '@poietica/agent-contract'

/*
 * 斜杠菜单：草稿以 / 开头时浮在输入框上沿的候选表。
 *
 * 纯视图。开不开、选中哪条、键盘怎么走，全归持有草稿的 PromptInput —— 键盘事件落在
 * textarea 上，菜单自己听不见；状态分两家就得再修一条同步管线。表来自 agent 报的命令
 * 表（AgentPalettePort 那一路），这里不定义任何命令，直接敲全名从来都有效。
 */

export interface SlashMenuProps {
  readonly entries: readonly PaletteEntry[]
  readonly highlighted: number
  readonly onPick: (entry: PaletteEntry) => void
}

export function SlashMenu({ entries, highlighted, onPick }: SlashMenuProps) {
  return (
    <div className="assistant-slash">
      <div className="assistant-slash__menu" role="listbox">
        {entries.map((entry, index) => (
          <div key={entry.name}>
            {/* mousedown 而不是 click：preventDefault 留住 textarea 的焦点，选完接着打字。 */}
            <button
              aria-selected={index === highlighted}
              className="assistant-slash__item"
              data-highlighted={index === highlighted ? 'true' : undefined}
              onMouseDown={(event) => {
                event.preventDefault()
                onPick(entry)
              }}
              role="option"
              type="button"
            >
              <span className="assistant-slash__label">{entry.label}</span>
              {entry.description === '' ? null : (
                <span className="assistant-slash__detail">{entry.description}</span>
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
