import { useEffect } from 'react'
import type { CommandRegistry } from '../command-registry'

/*
 * 快捷键的唯一真相源是命令自身声明的 shortcut，写作与平台无关的逻辑形式
 * （Mod+K、Mod+Shift+P）。本模块是这份声明的唯一消费者：
 *
 *   - 匹配按物理键位（event.code），不受 CapsLock、输入法与键盘布局影响；
 *   - 修饰键全等比较，Mod+Shift+K 不会命中 Mod+K；
 *   - 显示按平台渲染，macOS 给 ⌘ / ⌥ / ⇧，其余平台给 Ctrl / Alt / Shift。
 *
 * 曾经存在第二份声明（桌面壳里的绑定常量表），它与 register 的 shortcut 各自
 * 演化，已经出现只有一边有绑定的命令。派生优于同步：这里只留一份。
 */

const APPLE = /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? '')

/*
 * 键位与它的人类写法，一张表两个方向。
 *
 * 匹配比的是 event.code，而键盘上的逗号发出的是 Comma 不是 ","。此前
 * toKeyCode 只认 a-z 与 0-9，其余原样返回：声明 Mod+, 解析出 M:, ，
 * 而键盘永远发不出这个 code —— 那条绑定一次都不会触发，界面上却照样
 * 把它画出来。一个画得出来、按不动的快捷键，比没有更糟。
 *
 * 所以两个方向都从这一张表来：声明侧写 Mod+, 或 Mod+Comma 都对，显示侧
 * 一律翻回符号。
 */
const KEY_LABELS: Record<string, string> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
}

const KEY_CODES: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_LABELS).map(([code, label]) => [label, code]),
)

function toKeyCode(key: string): string {
  if (/^[a-z]$/i.test(key)) {
    return `Key${key.toUpperCase()}`
  }

  if (/^[0-9]$/.test(key)) {
    return `Digit${key}`
  }

  return KEY_CODES[key] ?? key
}

/*
 * 和弦的规范形式：修饰键固定顺序 + 物理键位。声明串与键盘事件都归一到
 * 同一个字符串，匹配因此是一次查表，而不是每次按键遍历全部命令再逐条解析。
 */
function chordOf(mod: boolean, shift: boolean, alt: boolean, code: string): string {
  return `${mod ? 'M' : ''}${shift ? 'S' : ''}${alt ? 'A' : ''}:${code}`
}

function parseChord(shortcut: string): string | null {
  const parts = shortcut.split('+')
  const key = parts.at(-1)

  if (key === undefined || key === '') {
    return null
  }

  return chordOf(
    parts.includes('Mod'),
    parts.includes('Shift'),
    parts.includes('Alt'),
    toKeyCode(key),
  )
}

/*
 * 把逻辑快捷键拆成当前平台的按键片段。
 *
 * 设置页要一枚键一个键帽地画，所以这一层给的是片段，拼接留在 formatKeybinding。
 * 两个形态共用同一张 KEY_LABELS 表 —— 否则命令面板与设置页会对同一条绑定给出
 * 两种写法，而没有任何机制会在它们分叉时报错。
 */
export function keybindingParts(shortcut: string): string[] {
  return shortcut.split('+').map((part) => {
    switch (part) {
      case 'Mod':
        return APPLE ? '⌘' : 'Ctrl'

      case 'Alt':
        return APPLE ? '⌥' : 'Alt'

      case 'Shift':
        return APPLE ? '⇧' : 'Shift'

      default:
        return KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part)
    }
  })
}

/** 把逻辑快捷键渲染成当前平台的习惯写法。 */
export function formatKeybinding(shortcut: string): string {
  return keybindingParts(shortcut).join(APPLE ? '' : '+')
}

/*
 * 文本录入区内不接管按键：Mod+B 在编辑器里是加粗，不是切换侧边栏。
 * 这与专业编辑器的 when-context 隔离是同一个约定。
 */
const TEXT_ENTRY_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_ENTRY_SELECTOR) !== null
}

/** 把注册表里所有命令的 shortcut 声明接上真实键盘事件。 */
export function useCommandKeybindings(registry: CommandRegistry): void {
  useEffect(() => {
    type Snapshot = ReturnType<CommandRegistry['getSnapshot']>

    let indexedSnapshot: Snapshot | null = null
    let chords = new Map<string, string>()

    /*
     * 注册表快照是稳定引用（useSyncExternalStore 的前提），因此引用未变即索引
     * 有效。注册表变更时按需重建一次，不需要额外订阅通道。
     */
    function chordIndex(): ReadonlyMap<string, string> {
      const snapshot = registry.getSnapshot()

      if (snapshot === indexedSnapshot) {
        return chords
      }

      const next = new Map<string, string>()

      for (const command of snapshot) {
        if (command.shortcut === undefined) {
          continue
        }

        const chord = parseChord(command.shortcut)

        if (chord !== null) {
          next.set(chord, command.id)
        }
      }

      indexedSnapshot = snapshot
      chords = next

      return next
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.isComposing || event.repeat || isTextEntry(event.target)) {
        return
      }

      const commandId = chordIndex().get(
        chordOf(event.ctrlKey || event.metaKey, event.shiftKey, event.altKey, event.code),
      )

      if (commandId === undefined) {
        return
      }

      event.preventDefault()
      void registry.execute(commandId)
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [registry])
}
