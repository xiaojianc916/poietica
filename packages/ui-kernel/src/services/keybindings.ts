import type { Disposable } from '@poietica/foundation'
import { builtinPoints } from '../builtin-points'
import type { ContributionRegistry } from '../contribution'
import type { CommandService } from './commands'
import { createValue, type Observable } from './observable'

/** commandId → 新按键；null 表示禁用 */
export type KeyOverrides = Readonly<Record<string, string | null>>

export interface KeybindingService extends Observable<KeyOverrides> {
  setOverrides(overrides: KeyOverrides): void
  /** 某命令当前生效的按键（覆盖优先），没有则 null；命令面板和设置页显示用 */
  keyFor(commandId: string): string | null
  /** 把键盘事件规范化成 'Ctrl+Shift+P' 形式；设置页“录制按键”也用它 */
  normalize(event: KeyboardEvent): string | null
  install(target: Window): Disposable
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])
const CODE_NAMES: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
}

export function normalizeKeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  let key: string
  if (e.code in CODE_NAMES) key = CODE_NAMES[e.code]!
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (/^F([1-9]|1[0-2])$/.test(e.key)) key = e.key
  else if (
    [
      'Enter',
      'Escape',
      'Tab',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ].includes(e.key)
  ) {
    key = e.key
  } else return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

export function createKeybindingService(registry: ContributionRegistry, commands: CommandService): KeybindingService {
  const overrides = createValue<KeyOverrides>({})
  const keyFor = (commandId: string): string | null => {
    const o = overrides.current()
    if (commandId in o) return o[commandId] ?? null
    return registry.list(builtinPoints.keybindings).find((k) => k.item.command === commandId)?.item.key ?? null
  }
  return {
    current: overrides.current,
    subscribe: overrides.subscribe,
    setOverrides: (o) => overrides.set(o),
    keyFor,
    normalize: normalizeKeyEvent,
    install(target) {
      const onKeyDown = (e: KeyboardEvent): void => {
        if (e.isComposing || e.defaultPrevented) return
        const key = normalizeKeyEvent(e)
        if (key === null) return
        const hasCommandModifier = e.ctrlKey || e.altKey || e.metaKey
        if (isTextInput(e.target) && !hasCommandModifier && key !== 'Escape') return
        // 先看覆盖表，再看默认绑定；同一按键多个候选时取第一个 when() 为真的
        const o = overrides.current()
        const candidates = [
          ...Object.entries(o)
            .filter(([, k]) => k === key)
            .map(([command]) => ({ command, when: undefined as (() => boolean) | undefined })),
          ...registry
            .list(builtinPoints.keybindings)
            .map((c) => c.item)
            .filter((b) => b.key === key && !(b.command in o)),
        ]
        const hit = candidates.find((c) => (c.when?.() ?? true) && commands.isEnabled(c.command))
        if (hit === undefined) return
        e.preventDefault()
        e.stopPropagation()
        void commands.execute(hit.command)
      }
      target.addEventListener('keydown', onKeyDown, { capture: true })
      return { dispose: () => target.removeEventListener('keydown', onKeyDown, { capture: true }) }
    },
  }
}
