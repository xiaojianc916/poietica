import './composer-palette.css'

import type { PromptConfiguration } from '@poietica/conversation'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { CheckIcon } from '../primitives/icons'
import { ENTER_EASE, ENTER_SECONDS, EXIT_EASE, EXIT_SECONDS, RISE_PX } from '../primitives/motion'

/*
 * 输入框上沿那张面板，加号翻开。
 *
 * 纯视图。开不开、高亮哪一行、键盘怎么走，全归持有草稿的 PromptInput —— 键盘
 * 事件落在 contenteditable 上，面板自己听不见。行由调用方摊平后交进来，所以这里
 * 不认识 agent、不认识技能、也不认识文件选择器。
 */

/*
 * 选中一行之后做什么。
 *
 * 要动草稿的一律只声明意图，由持有草稿的 PromptInput 执行 —— 面板算不出光标，
 * 也不该拿到写草稿的权力。
 */
export type PaletteAction =
  | { readonly kind: 'insert'; readonly chip: import('./prompt-chip').PromptChipValue }
  | {
      readonly kind: 'configure'
      readonly configuration: PromptConfiguration
      readonly label: string
    }
  | { readonly kind: 'run'; readonly run: (draft: string) => void }

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

  readonly action: PaletteAction
}

export interface PaletteGroup {
  readonly id: string
  readonly heading: string
  readonly rows: readonly PaletteRow[]
}

/** 面板与输入框共用这一条 id 规则：活动项由 aria-activedescendant 指过来。 */
export function paletteOptionId(listboxId: string, rowId: string): string {
  return `${listboxId}-${rowId}`
}

export interface ComposerPaletteProps {
  readonly groups: readonly PaletteGroup[]
  /** 开合的真相在 PromptInput，这里只负责把它播出来。 */
  readonly isOpen: boolean
  /** listbox 自己的 id：输入框拿它填 aria-controls。 */
  readonly listboxId: string
  /** 在摊平后的行序列里的下标。 */
  readonly highlighted: number
  /** 指针进入某一行时把高亮挪过去：任何时刻只有一行有悬停色。 */
  readonly onHighlight: (index: number) => void
  readonly onPick: (row: PaletteRow) => void
}

export function ComposerPalette({
  groups,
  highlighted,
  isOpen,
  listboxId,
  onHighlight,
  onPick,
}: ComposerPaletteProps) {
  const flat = groups.flatMap((group) => group.rows)

  /* 关掉动画是系统级偏好，不是这一处的开关。 */
  const reduced = useReducedMotion() === true
  const enter = reduced ? 0 : ENTER_SECONDS
  const exit = reduced ? 0 : EXIT_SECONDS

  return (
    <div className="composer-palette">
      {/* initial={false}：开窗那一帧不该播一遍，那不是一次交互。 */}
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            animate={{
              opacity: 1,
              scale: 1,
              transition: { duration: enter, ease: ENTER_EASE },
              y: 0,
            }}
            className="composer-palette__panel"
            exit={{
              opacity: 0,
              /* 退场那几十毫秒里它还在，别让一次误点落在正在消失的行上。 */
              pointerEvents: 'none',
              scale: 0.98,
              transition: { duration: exit, ease: EXIT_EASE },
              y: RISE_PX,
            }}
            id={listboxId}
            initial={{ opacity: 0, scale: 0.98, y: RISE_PX }}
            key="composer-palette"
            role="listbox"
          >
            {groups.map((group) => (
              <div className="composer-palette__group" key={group.id}>
                <div className="composer-palette__heading">{group.heading}</div>

                {group.rows.map((row) => {
                  const at = flat.indexOf(row)

                  return (
                    /* mousedown 而不是 click：preventDefault 拦住焦点转移，落点由 onPick 决定。 */
                    <button
                      aria-selected={at === highlighted}
                      className="composer-palette__row"
                      data-highlighted={at === highlighted ? 'true' : undefined}
                      id={paletteOptionId(listboxId, row.id)}
                      key={row.id}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        onPick(row)
                      }}
                      onMouseEnter={() => {
                        onHighlight(at)
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
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
