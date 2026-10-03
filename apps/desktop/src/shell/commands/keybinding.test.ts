import { describe, expect, test } from 'bun:test'
import { chordIndexOf, commandOfKey } from './keybinding'

/*
 * 归属判据只有一条：这个和弦在命令表里登没登记。
 *
 * 从前还叠了一条「焦点在输入框里就整个不问」，实测的后果是**在消息框里按 Ctrl+K
 * 打不开命令面板**（聚焦编辑器 → dialog 0 个；失焦 → 17 个）。这些用例把「登记即拥有」
 * 钉住，并且顺带钉住「没登记的组合一个都不抢」。
 */
const COMMANDS = [
  { id: 'application.toggle-command-palette', shortcut: 'Mod+K' },
  { id: 'workspace.toggle-sidebar', shortcut: 'Mod+B' },
  { id: 'application.open-settings', shortcut: 'Mod+,' },
  { id: 'workspace.next-tab', shortcut: 'Mod+Shift+]' },
  { id: 'no.shortcut' },
]

const chords = chordIndexOf(COMMANDS)

const key = (over: Partial<Record<string, unknown>> = {}) => ({
  code: 'KeyK',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
})

describe('command keybindings', () => {
  test('a registered chord resolves to its command', () => {
    expect(commandOfKey(chords, key({ ctrlKey: true }))).toBe('application.toggle-command-palette')
  })

  /* Ctrl 与 Cmd 是同一条声明（Mod），平台差异不在声明里。 */
  test('meta is the same chord as control', () => {
    expect(commandOfKey(chords, key({ metaKey: true }))).toBe('application.toggle-command-palette')
  })

  test('a modifier chord that is not registered belongs to nobody', () => {
    /* 编辑器自己的 Ctrl+U（打开文件选择器）之类：命令表里没有就不该被应用接走。 */
    expect(commandOfKey(chords, key({ ctrlKey: true, code: 'KeyU' }))).toBeUndefined()
    expect(
      commandOfKey(chords, key({ ctrlKey: true, shiftKey: true, code: 'ArrowLeft' })),
    ).toBeUndefined()
  })

  test('shift is part of the chord, not a wrapper around it', () => {
    expect(commandOfKey(chords, key({ ctrlKey: true, code: 'BracketRight' }))).toBeUndefined()
    expect(commandOfKey(chords, key({ ctrlKey: true, shiftKey: true, code: 'BracketRight' }))).toBe(
      'workspace.next-tab',
    )
  })

  /* 逗号比的是物理键：声明侧写 Mod+, 与 Mod+Comma 同义。 */
  test('punctuation is matched by physical key, not by the character', () => {
    expect(commandOfKey(chords, key({ ctrlKey: true, code: 'Comma' }))).toBe(
      'application.open-settings',
    )
  })

  test('a bare key is never a command', () => {
    expect(commandOfKey(chords, key())).toBeUndefined()
  })

  test('commands without a shortcut never enter the table', () => {
    expect([...chords.values()]).not.toContain('no.shortcut')
  })
})
