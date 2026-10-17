import './composer-palette.css'

import type { SlashCommand } from '@poietica/engine'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from 'react'
import type { PromptConfiguration } from '../../shared/model/session'
import { AttachIcon, CheckIcon } from '../../shared/primitives/icons'
import { ENTER_EASE, ENTER_SECONDS, EXIT_EASE, EXIT_SECONDS, RISE_PX } from '../../shared/primitives/motion'

/* 输入框上沿那张面板（加号翻开，或草稿敲下行首 `/`）。纯视图：开合、高亮、键盘都归持有草稿的 PromptInput —— 键盘事件落在 contenteditable 上，面板自己听不见。 */

/* 选中一行之后做什么。要动草稿的一律只声明意图，由持有草稿的 PromptInput 执行。 */
export type PaletteAction =
  | { readonly kind: 'insert'; readonly chip: import('../../shared/primitives/prompt-chip').PromptChipValue }
  | {
      readonly kind: 'configure'
      readonly configuration: PromptConfiguration
      readonly label: string
    }
  | { readonly kind: 'run'; readonly run: (draft: string) => void }
  /* 斜杠命令：回车执行（必填参数的先补参数），Tab 只补全名字 —— 草稿怎么改归 PromptInput */
  | { readonly kind: 'command'; readonly command: SlashCommand }

/** 这一行是怎么被选中的：Tab 只补全，回车与点击是「就要这一条」 */
export type PaletteVia = 'enter' | 'tab'

export interface PaletteRow {
  readonly id: string
  /** 缺席就不留图标位（命令面板一列都是命令，同一枚图标重复几十遍只是噪音） */
  readonly icon?: ReactNode
  readonly label: string
  /** 紧跟名字的参数提示（`[标题]`、`<路径>`） */
  readonly argument?: string | undefined
  readonly detail?: string | undefined
  readonly hint?: string | undefined
  readonly checked?: boolean | undefined

  readonly action: PaletteAction
}

export interface PaletteGroup {
  readonly id: string
  readonly heading: string
  readonly rows: readonly PaletteRow[]
}

/** 面板与输入框共用的 id 规则：活动项由 aria-activedescendant 指过来。 */
export function paletteOptionId(listboxId: string, rowId: string): string {
  return `${listboxId}-${rowId}`
}

/**
 * 面板开着时这几个键归面板。两个 composer 共用一条规则，抄成两份就会只补到其中一处。
 * 只在捕获相调用，放编辑器先看见方向键光标就先挪走了；`stopPropagation` 归调用方（主输入框里还有 Lexical 在听）。
 */
export function paletteKeyDown(
  event: KeyboardEvent<HTMLFormElement>,
  {
    highlighted,
    onClose,
    onHighlight,
    onPick,
    open,
    rows,
    stopPropagation,
  }: {
    readonly highlighted: number
    readonly onClose: () => void
    readonly onHighlight: (index: number) => void
    readonly onPick: (row: PaletteRow, via: PaletteVia) => void
    readonly open: boolean
    readonly rows: readonly PaletteRow[]
    readonly stopPropagation: boolean
  },
): void {
  if (!open || event.nativeEvent.isComposing) {
    return
  }

  const swallow = (): void => {
    event.preventDefault()

    if (stopPropagation) {
      event.stopPropagation()
    }
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    swallow()
    onHighlight((highlighted + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)

    return
  }

  if (event.key === 'Enter' || event.key === 'Tab') {
    swallow()

    const chosen = rows[highlighted] ?? rows[0]

    if (chosen !== undefined) {
      onPick(chosen, event.key === 'Tab' ? 'tab' : 'enter')
    }

    return
  }

  if (event.key === 'Escape') {
    swallow()
    onClose()
  }
}

export function composerComposeGroup(onAddFile: () => void): PaletteGroup {
  return {
    id: 'compose',
    heading: '添加',
    rows: [
      {
        id: 'compose:file',
        icon: <AttachIcon aria-hidden="true" />,
        label: '添加文件',
        hint: 'Ctrl+U',
        action: { kind: 'run', run: onAddFile },
      },
    ],
  }
}

/**
 * 点到框外就收面板：捕获相 pointerdown，因为点不可聚焦区域不移走焦点。两个 composer 共用。
 * `portal` 是另一块也算框内的元素：面板经传送门落在 body 下，不带上它就会「点自己反而把自己关掉」。
 */
export function useDismissOutside(
  open: boolean,
  inside: RefObject<Element | null>,
  close: () => void,
  portal?: RefObject<Element | null>,
): void {
  useEffect(() => {
    if (!open) {
      return undefined
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node) {
        if (inside.current?.contains(event.target) === true) {
          return
        }

        if (portal?.current?.contains(event.target) === true) {
          return
        }
      }

      close()
    }

    document.addEventListener('pointerdown', onPointerDown, true)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [close, inside, open, portal])
}

/* 一行的几格：图标（可缺）· 名字 · 参数提示 · 说明 · 快捷键 · 勾。拆出来是为了让列表那层只管高亮与选中。 */
function PaletteRowContent({ row }: { readonly row: PaletteRow }) {
  return (
    <>
      {row.icon == null ? null : <span className="composer-palette__icon">{row.icon}</span>}

      <span className="composer-palette__label">{row.label}</span>

      {row.argument === undefined ? null : <span className="composer-palette__argument">{row.argument}</span>}

      {row.detail === undefined ? null : <span className="composer-palette__detail">{row.detail}</span>}

      {row.hint === undefined ? null : <kbd className="composer-palette__hint">{row.hint}</kbd>}

      {row.checked === true ? (
        <span className="composer-palette__tick">
          <CheckIcon aria-hidden="true" />
        </span>
      ) : null}
    </>
  )
}

export interface ComposerPaletteProps {
  readonly groups: readonly PaletteGroup[]
  readonly isOpen: boolean
  readonly listboxId: string
  readonly highlighted: number
  /** 指针进入某一行时把高亮挪过去：任何时刻只有一行有悬停色。 */
  readonly onHighlight: (index: number) => void
  readonly onPick: (row: PaletteRow, via: PaletteVia) => void
}

export function ComposerPalette({ groups, highlighted, isOpen, listboxId, onHighlight, onPick }: ComposerPaletteProps) {
  /* 高亮位置按拍平后的序号算。逐行现查一次就是每次按键一遍 O(n²)。 */
  let at = 0
  const laid = groups.map((group) => {
    const start = at
    at += group.rows.length
    return { group, start }
  })

  /* 关掉动画是系统级偏好，不是这一处的开关。 */
  const reduced = useReducedMotion() === true
  const enter = reduced ? 0 : ENTER_SECONDS
  const exit = reduced ? 0 : EXIT_SECONDS

  /*
   * 方向键走到可视区外的那一行，把它滚进来：命令面板几十行，不滚就是高亮从眼前消失。
   * 只服务键盘。指针挪过去不滚：滚动会让指针底下换成另一行，mouseenter 再报一次，高亮与滚动互相追着跑，
   * 屏幕上就是面板随鼠标上下抖（行只露出一半时最明显）。能悬停到的行本来就在视野里，不需要滚。
   */
  const panel = useRef<HTMLDivElement>(null)
  const pointerPicked = useRef<number | null>(null)
  useEffect(() => {
    if (!isOpen) {
      pointerPicked.current = null

      return
    }
    if (pointerPicked.current === highlighted) {
      /* 这一跳是鼠标自己挪过来的：只换高亮，不动滚动位置。 */
      pointerPicked.current = null

      return
    }
    panel.current?.querySelectorAll<HTMLElement>('[role="option"]')[highlighted]?.scrollIntoView?.({ block: 'nearest' })
  }, [highlighted, isOpen])

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
            ref={panel}
            role="listbox"
          >
            {laid.map(({ group, start }) => (
              <div className="composer-palette__group" key={group.id}>
                <div className="composer-palette__heading">{group.heading}</div>

                {group.rows.map((row, offset) => {
                  const at = start + offset

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
                        onPick(row, 'enter')
                      }}
                      onMouseEnter={() => {
                        /* 已经高亮的那一行不重复 set：state 不变、effect 不跑，标记会留到下一次键盘操作上。 */
                        if (at === highlighted) {
                          return
                        }
                        /* 记一笔来源：下面那个滚动 effect 据此把「指针挪过来的」那一跳跳过去。 */
                        pointerPicked.current = at
                        onHighlight(at)
                      }}
                      role="option"
                      type="button"
                    >
                      <PaletteRowContent row={row} />
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
