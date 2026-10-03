import type { CommandRegistry } from '@poietica/workspace'
import { useEffect } from 'react'

const APPLE = /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? '')

/* 匹配比的是 event.code（物理键名，逗号发 Comma 而非 ","）：声明侧 Mod+, / Mod+Comma 等价，显示侧一律翻回符号。 */
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

export function formatKeybinding(shortcut: string): string {
  return shortcut
    .split('+')
    .map((part) => {
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
    .join(APPLE ? '' : '+')
}

/*
 * 归属判据只有一条：**这个和弦在命令表里登没登记**。
 *
 * 从前还叠了一条「焦点在输入框里就整个不问」，于是**在消息框里按 Ctrl+K 打不开命令
 * 面板** —— 而那正是最常用的位置（phase 2 实测：聚焦编辑器 → dialog 0 个；失焦 → 17 个）。
 *
 * 挑一条「带修饰键就放行」是第二份判据，它会把编辑器自己的组合（Shift+方向选字之类）
 * 也一并抢走。登记表已经是「应用拥有哪些键」的唯一定义，这里读它就够了。
 */

/* 一份快照 → 和弦表。纯函数：只认声明，不认事件，也不认焦点。 */
export function chordIndexOf(
  commands: readonly { readonly id: string; readonly shortcut?: string }[],
): ReadonlyMap<string, string> {
  const chords = new Map<string, string>()

  for (const command of commands) {
    if (command.shortcut === undefined) {
      continue
    }

    const chord = parseChord(command.shortcut)

    if (chord !== null) {
      chords.set(chord, command.id)
    }
  }

  return chords
}

/* 这次按键落在哪个已登记的命令上；没登记就是 undefined。 */
export function commandOfKey(
  chords: ReadonlyMap<string, string>,
  event: {
    readonly code: string
    readonly ctrlKey: boolean
    readonly metaKey: boolean
    readonly shiftKey: boolean
    readonly altKey: boolean
  },
): string | undefined {
  return chords.get(
    chordOf(event.ctrlKey || event.metaKey, event.shiftKey, event.altKey, event.code),
  )
}

export function useCommandKeybindings(registry: CommandRegistry): void {
  useEffect(() => {
    type Snapshot = ReturnType<CommandRegistry['getSnapshot']>

    let indexedSnapshot: Snapshot | null = null
    let chords: ReadonlyMap<string, string> = new Map<string, string>()

    function chordIndex(): ReadonlyMap<string, string> {
      const snapshot = registry.getSnapshot()

      if (snapshot === indexedSnapshot) {
        return chords
      }

      indexedSnapshot = snapshot
      chords = chordIndexOf(snapshot)

      return chords
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.isComposing || event.repeat) {
        return
      }

      const commandId = commandOfKey(chordIndex(), event)

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
