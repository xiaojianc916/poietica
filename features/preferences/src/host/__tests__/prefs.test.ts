import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createJsonDocument } from '@poietica/fs-kit'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import { Preferences, type PreferencesPatch } from '../../contract/entities'
import { createKeymapService } from '../keymap-service'
import { createPrefsService, mergePatch } from '../prefs-service'
import { createUiStateService } from '../ui-state-service'

describe('mergePatch', () => {
  test('只改 general.notifyOnCompletion，其它字段保持默认', () => {
    const cur = Preferences.parse({})
    const next = mergePatch(cur, { general: { notifyOnCompletion: false } })
    expect(next.general.notifyOnCompletion).toBe(false)
    expect(next.general.sendWithModifier).toBe(false)
    expect(next.general.confirmBeforeDelete).toBe(true)
    expect(next.theme).toBe('system')
    expect(next.appearance).toEqual(cur.appearance)
    expect(next.updates).toEqual({ autoCheck: true })
  })

  test('顶层字段只在 patch 里出现过才覆盖', () => {
    const cur = Preferences.parse({ theme: 'dark', logLevel: 'debug' })
    const next = mergePatch(cur, { language: 'en' })
    expect(next.theme).toBe('dark')
    expect(next.logLevel).toBe('debug')
    expect(next.language).toBe('en')
  })

  test('空 patch 是恒等变换', () => {
    const cur = Preferences.parse({})
    expect(mergePatch(cur, {})).toEqual(cur)
  })

  test('非法值被 schema 拒绝', () => {
    const cur = Preferences.parse({})
    expect(() => mergePatch(cur, { theme: 'blue' as never })).toThrow()
  })
})

describe('Preferences 默认值', () => {
  test('parse({}) 得到完整默认值', () => {
    const p = Preferences.parse({})
    expect(p).toEqual({
      theme: 'system',
      language: 'zh-CN',
      logLevel: 'info',
      general: { sendWithModifier: false, confirmBeforeDelete: true, notifyOnCompletion: true },
      appearance: { density: 'comfortable', reduceMotion: false, messageTimestamps: false },
      modelPicker: { hiddenModels: [], providerOrder: [] },
      updates: { autoCheck: true },
    })
  })

  test('旧文件缺少 updates 分组时补上默认值', () => {
    const p = Preferences.parse({ theme: 'dark' })
    expect(p.updates).toEqual({ autoCheck: true })
    expect(p.theme).toBe('dark')
  })
})

async function makePrefs(overrides: Partial<{ file: string }> = {}) {
  const dir = await tempDir('prefs-')
  const logger = createTestLogger()
  const applied: Array<{ prev: unknown; next: unknown }> = []
  const changed: unknown[] = []
  const doc = createJsonDocument({
    file: overrides.file ?? path.join(dir.path, 'preferences.json'),
    schema: Preferences,
    defaults: () => Preferences.parse({}),
    logger,
  })
  const service = createPrefsService({
    doc,
    applyEffects: (prev, next) => applied.push({ prev, next }),
    emitChanged: (p) => changed.push(p),
    logger,
  })
  await service.load()
  return { dir, service, applied, changed, logger, file: overrides.file ?? path.join(dir.path, 'preferences.json') }
}

describe('prefs-service', () => {
  test('update 的顺序：写盘之后才广播并执行副作用', async () => {
    const t = await makePrefs()
    await t.service.update({ general: { notifyOnCompletion: false } })
    expect(t.changed.length).toBe(1)
    expect(t.applied.length).toBe(1)
    expect(t.service.get().general.notifyOnCompletion).toBe(false)
    await t.dir.dispose()
  })

  test('坏文件被改名并用默认值（记 warn）', async () => {
    const dir = await tempDir('prefs-bad-')
    const file = path.join(dir.path, 'preferences.json')
    writeFileSync(file, '{bad json')
    const logger = createTestLogger()
    const doc = createJsonDocument({ file, schema: Preferences, defaults: () => Preferences.parse({}), logger })
    const loaded = await doc.load()
    expect(loaded).toEqual(Preferences.parse({}))
    expect(logger.at('warn').length).toBeGreaterThan(0)
    await dir.dispose()
  })

  test('无 patch 时 update 返回当前值', async () => {
    const t = await makePrefs()
    const next = await t.service.update({} satisfies PreferencesPatch)
    expect(next.theme).toBe('system')
    await t.dir.dispose()
  })
})

describe('ui-state-service', () => {
  test('连续 10 次 set 只在去抖后写一次，内容为最后一次', async () => {
    const dir = await tempDir('uistate-')
    const file = path.join(dir.path, 'ui-state.json')
    const service = createUiStateService({
      file,
      logger: createTestLogger(),
      debounceMs: 20,
    })
    await service.load()
    for (let i = 0; i < 10; i++) service.set('layout', { width: i })
    // 去抖窗口内只写最后一次（08 页 §6.1 的 saveDebounced）
    await Bun.sleep(60)
    await service.flush()
    const written = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>
    expect(written.layout).toEqual({ width: 9 })
    await dir.dispose()
  })

  test('flush 立即落盘（onShutdown 用）', async () => {
    const dir = await tempDir('uistate-')
    const file = path.join(dir.path, 'ui-state.json')
    const service = createUiStateService({ file, logger: createTestLogger(), debounceMs: 60_000 })
    await service.load()
    service.set('navigation', { surface: 'x', params: {} })
    await service.flush()
    expect(JSON.parse(await Bun.file(file).text())).toEqual({ navigation: { surface: 'x', params: {} } })
    await dir.dispose()
  })

  test('未设置的键返回 null', async () => {
    const dir = await tempDir('uistate-')
    const service = createUiStateService({ file: path.join(dir.path, 'ui-state.json'), logger: createTestLogger() })
    await service.load()
    expect(service.get('layout')).toBeNull()
    await dir.dispose()
  })

  test('坏文件被忽略（不抛错）', async () => {
    const dir = await tempDir('uistate-')
    const file = path.join(dir.path, 'ui-state.json')
    writeFileSync(file, 'not json')
    const logger = createTestLogger()
    const service = createUiStateService({ file, logger })
    await service.load()
    expect(logger.at('warn').length).toBeGreaterThan(0)
    await dir.dispose()
  })

  test('读回已落盘的值', async () => {
    const dir = await tempDir('uistate-')
    const file = path.join(dir.path, 'ui-state.json')
    writeFileSync(file, JSON.stringify({ layout: { sidebar: { visible: false } } }))
    const service = createUiStateService({ file, logger: createTestLogger() })
    await service.load()
    expect(service.get('layout')).toEqual({ sidebar: { visible: false } })
    await dir.dispose()
  })
})

describe('keymap-service', () => {
  test('set / reset 立即落盘', async () => {
    const dir = await tempDir('keymap-')
    const file = path.join(dir.path, 'keymap.json')
    const service = createKeymapService({ file, logger: createTestLogger() })
    await service.load()
    expect(service.current()).toEqual({})
    service.set('workbench.toggleSidebar', 'Ctrl+Shift+B')
    await new Promise((r) => setTimeout(r, 20))
    expect(JSON.parse(await Bun.file(file).text())).toEqual({ 'workbench.toggleSidebar': 'Ctrl+Shift+B' })
    service.reset()
    await new Promise((r) => setTimeout(r, 20))
    expect(JSON.parse(await Bun.file(file).text())).toEqual({})
    await dir.dispose()
  })

  test('null 表示禁用', async () => {
    const dir = await tempDir('keymap-')
    const service = createKeymapService({ file: path.join(dir.path, 'keymap.json'), logger: createTestLogger() })
    await service.load()
    expect(service.set('a.b', null)).toEqual({ 'a.b': null })
    await dir.dispose()
  })

  test('读回已有覆盖表', async () => {
    const dir = await tempDir('keymap-')
    const file = path.join(dir.path, 'keymap.json')
    writeFileSync(file, JSON.stringify({ 'a.b': 'Ctrl+K' }))
    const service = createKeymapService({ file, logger: createTestLogger() })
    await service.load()
    expect(service.current()).toEqual({ 'a.b': 'Ctrl+K' })
    await dir.dispose()
  })
})
