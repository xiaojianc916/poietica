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

const TEXT_ENTRY_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_ENTRY_SELECTOR) !== null
}

export function useCommandKeybindings(registry: CommandRegistry): void {
  useEffect(() => {
    type Snapshot = ReturnType<CommandRegistry['getSnapshot']>

    let indexedSnapshot: Snapshot | null = null
    let chords = new Map<string, string>()

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
