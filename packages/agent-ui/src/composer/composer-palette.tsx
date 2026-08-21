import './composer-palette.css'

import type { PaletteEntry } from '@poietica/agent-contract'
import type { ReactNode } from 'react'
import { CheckIcon } from '../primitives/icons'

/*
 * 输入框上沿那张面板：加号翻开的和斜杠触发的是同一张。
 *
 * 纯视图。开不开、高亮哪一行、键盘怎么走，全归持有草稿的 PromptInput —— 键盘
 * 事件落在 textarea 上，面板自己听不见。行由调用方摊平后交进来，所以这里不认识
 * agent、不认识技能、也不认识文件选择器。
 */

/*
 * 选中一行之后做什么。
 *
 * 要动草稿的一律只声明意图，由持有草稿的 PromptInput 执行 —— 面板算不出光标，
 * 也不该拿到写草稿的权力。
 */
export type PaletteAction =
  | { readonly kind: 'insert'; readonly snippet: string }
  | { readonly kind: 'run'; readonly run: () => void }
  | { readonly kind: 'skill'; readonly skill: PaletteEntry }
  | { readonly kind: 'goal' }
  | { readonly kind: 'swarm' }

export interface PaletteRow {
  readonly id: string
  readonly icon: ReactNode
  readonly label: string
  /** 名字后面那句淡字。 */
  readonly detail?: string | undefined
  /** 最右侧的键位提示。 */
  readonly hint?: string | undefined
  /** 打勾：这一行是此刻生效的那一档。 */
  readonly checked?: boolean | undefined
  /** 置灰不可点：此刻的条件还不成立（如没有可设为目标的正文）。 */
  readonly disabled?: boolean | undefined
  /** 斜杠过滤时拿来匹配的调用式。没有就不参与斜杠过滤。 */
  readonly token?: string | undefined
  readonly action: PaletteAction
}

export interface PaletteGroup {
  readonly id: string
  readonly heading: string
  readonly rows: readonly PaletteRow[]
}

export interface ComposerPaletteProps {
  readonly groups: readonly PaletteGroup[]
  /** 在摊平后的行序列里的下标。 */
  readonly highlighted: number
  /** 指针进入某一行时把高亮挪过去：任何时刻只有一行有悬停色。 */
  readonly onHighlight: (index: number) => void
  readonly onPick: (row: PaletteRow) => void
}

export function ComposerPalette({
  groups,
  highlighted,
  onHighlight,
  onPick,
}: ComposerPaletteProps) {
  const flat = groups.flatMap((group) => group.rows)

  return (
    <div className="composer-palette">
      <div className="composer-palette__panel" role="listbox">
        {groups.map((group) => (
          <div className="composer-palette__group" key={group.id}>
            <div className="composer-palette__heading">{group.heading}</div>

            {group.rows.map((row) => {
              const at = flat.indexOf(row)

              return (
                /* mousedown 而不是 click：preventDefault 留住 textarea 的焦点，选完接着打字。 */
                <button
                  aria-selected={at === highlighted}
                  className="composer-palette__row"
                  data-highlighted={at === highlighted ? 'true' : undefined}
                  disabled={row.disabled}
                  key={row.id}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    onPick(row)
                  }}
                  onMouseEnter={() => {
                    if (row.disabled !== true) {
                      onHighlight(at)
                    }
                  }}
                  role="option"
                  type="button"
                >
                  <span className="composer-palette__icon">{row.icon}</span>

                  <span className="composer-palette__label">{row.label}</span>

                  {row.detail === undefined ? null : (
                    <span className="composer-palette__detail">{row.detail}</span>
                  )}

                  {row.hint === undefined ? null : (
                    <kbd className="composer-palette__hint">{row.hint}</kbd>
                  )}

                  {row.checked === true ? (
                    <span className="composer-palette__tick">
                      <CheckIcon aria-hidden="true" />
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
