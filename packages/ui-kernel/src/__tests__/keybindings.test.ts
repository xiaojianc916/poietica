import { describe, expect, test } from 'bun:test'
import { builtinPoints } from '../builtin-points'
import { ContributionRegistry } from '../contribution'
import { createCommandService } from '../services/commands'
import { createKeybindingService, normalizeKeyEvent } from '../services/keybindings'
import { createToastService } from '../services/toasts'

function setup() {
  const registry = new ContributionRegistry()
  const toasts = createToastService({})
  const commands = createCommandService(registry, toasts, { ...consoleLogger })
  const keybindings = createKeybindingService(registry, commands)
  return { registry, commands, keybindings, toasts }
}

const consoleLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => consoleLogger,
}

function keydown(init: Partial<KeyboardEventInit> & { code?: string; key?: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
}

describe('normalizeKeyEvent', () => {
  test('字母与修饰键', () => {
    expect(normalizeKeyEvent({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true } as KeyboardEvent)).toBe(
      'Ctrl+Shift+P',
    )
  })
  test('反引号', () => {
    expect(normalizeKeyEvent({ key: '`', code: 'Backquote', ctrlKey: true } as KeyboardEvent)).toBe('Ctrl+`')
  })
  test('功能键与方向键', () => {
    expect(normalizeKeyEvent({ key: 'F5', code: 'F5' } as KeyboardEvent)).toBe('F5')
    expect(normalizeKeyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true } as KeyboardEvent)).toBe(
      'Alt+ArrowLeft',
    )
  })
  test('单独的修饰键返回 null', () => {
    expect(normalizeKeyEvent({ key: 'Control', code: 'ControlLeft' } as KeyboardEvent)).toBeNull()
  })
  test('认不出的键返回 null', () => {
    expect(normalizeKeyEvent({ key: 'Dead', code: 'Unknown' } as KeyboardEvent)).toBeNull()
  })
})

describe('快捷键服务', () => {
  test('UK-3 模拟按键执行命令一次', () => {
    const { registry, commands, keybindings } = setup()
    let runs = 0
    registry.add(builtinPoints.commands, 'a', {
      id: 'a.do',
      title: '做',
      run: () => {
        runs++
      },
    })
    registry.add(builtinPoints.keybindings, 'a', { command: 'a.do', key: 'Ctrl+Shift+P' })
    const target = new EventTarget()
    const d = keybindings.install(target as unknown as Window)
    target.dispatchEvent(keydown({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }))
    expect(runs).toBe(1)
    d.dispose()
    void commands
  })

  test('UK-3 输入框获得焦点时不触发全局快捷键', () => {
    const { registry, keybindings } = setup()
    let runs = 0
    registry.add(builtinPoints.commands, 'a', {
      id: 'a.do',
      title: '做',
      run: () => {
        runs++
      },
    })
    registry.add(builtinPoints.keybindings, 'a', { command: 'a.do', key: 'Delete' })
    const input = document.createElement('input')
    document.body.append(input)
    const d = keybindings.install(window)
    input.dispatchEvent(keydown({ key: 'Delete', code: 'Delete' }))
    expect(runs).toBe(0)
    d.dispose()
    input.remove()
  })

  test('Escape 在输入框里也会触发', () => {
    const { registry, keybindings } = setup()
    let runs = 0
    registry.add(builtinPoints.commands, 'a', {
      id: 'a.esc',
      title: '取消',
      run: () => {
        runs++
      },
    })
    registry.add(builtinPoints.keybindings, 'a', { command: 'a.esc', key: 'Escape' })
    const input = document.createElement('input')
    document.body.append(input)
    const d = keybindings.install(window)
    input.dispatchEvent(keydown({ key: 'Escape', code: 'Escape' }))
    expect(runs).toBe(1)
    d.dispose()
    input.remove()
  })

  test('keyFor：覆盖优先，null 表示禁用', () => {
    const { registry, keybindings } = setup()
    registry.add(builtinPoints.keybindings, 'a', { command: 'a.do', key: 'Ctrl+K' })
    expect(keybindings.keyFor('a.do')).toBe('Ctrl+K')
    keybindings.setOverrides({ 'a.do': 'Ctrl+J' })
    expect(keybindings.keyFor('a.do')).toBe('Ctrl+J')
    keybindings.setOverrides({ 'a.do': null })
    expect(keybindings.keyFor('a.do')).toBeNull()
  })

  test('覆盖表里的绑定优先于默认绑定', () => {
    const { registry, keybindings } = setup()
    let runs = 0
    registry.add(builtinPoints.commands, 'a', {
      id: 'a.do',
      title: '做',
      run: () => {
        runs++
      },
    })
    registry.add(builtinPoints.commands, 'a', {
      id: 'a.other',
      title: '别的',
      run: () => {
        runs += 10
      },
    })
    registry.add(builtinPoints.keybindings, 'a', { command: 'a.other', key: 'Ctrl+K' })
    keybindings.setOverrides({ 'a.do': 'Ctrl+K' })
    const d = keybindings.install(window)
    window.dispatchEvent(keydown({ key: 'K', code: 'KeyK', ctrlKey: true }))
    expect(runs).toBe(1)
    d.dispose()
  })

  test('when() 为假的候选被跳过', () => {
    const { registry, keybindings } = setup()
    let runs = 0
    registry.add(builtinPoints.commands, 'a', {
      id: 'a.do',
      title: '做',
      run: () => {
        runs++
      },
    })
    registry.add(builtinPoints.keybindings, 'a', { command: 'a.do', key: 'Ctrl+K', when: () => false })
    const d = keybindings.install(window)
    window.dispatchEvent(keydown({ key: 'K', code: 'KeyK', ctrlKey: true }))
    expect(runs).toBe(0)
    d.dispose()
  })

  test('禁用的命令不执行', () => {
    const { registry, keybindings } = setup()
    let runs = 0
    registry.add(builtinPoints.commands, 'a', {
      id: 'a.do',
      title: '做',
      run: () => {
        runs++
      },
      enabled: () => false,
    })
    registry.add(builtinPoints.keybindings, 'a', { command: 'a.do', key: 'Ctrl+K' })
    const d = keybindings.install(window)
    window.dispatchEvent(keydown({ key: 'K', code: 'KeyK', ctrlKey: true }))
    expect(runs).toBe(0)
    d.dispose()
  })
})

describe('命令服务', () => {
  test('未知命令只记 warn，不抛错', async () => {
    const { commands, toasts } = setup()
    await expect(commands.execute('nope')).resolves.toBeUndefined()
    /* 未知命令不是失败：不弹 toast，静默收场。 */
    expect(toasts.current()).toEqual([])
  })

  test('命令抛错时显示 toast', async () => {
    const { registry, commands, toasts } = setup()
    registry.add(builtinPoints.commands, 'a', {
      id: 'a.bad',
      title: '坏命令',
      run: () => {
        throw new Error('坏了')
      },
    })
    await commands.execute('a.bad')
    expect(toasts.current().length).toBe(1)
    expect(toasts.current()[0]!.title).toContain('坏命令')
  })

  test('isEnabled', () => {
    const { registry, commands } = setup()
    registry.add(builtinPoints.commands, 'a', { id: 'a.on', title: 'on', run: () => undefined })
    registry.add(builtinPoints.commands, 'a', { id: 'a.off', title: 'off', run: () => undefined, enabled: () => false })
    expect(commands.isEnabled('a.on')).toBe(true)
    expect(commands.isEnabled('a.off')).toBe(false)
    expect(commands.isEnabled('nope')).toBe(false)
  })
})
