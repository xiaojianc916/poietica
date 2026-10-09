import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import { createWindowStateStore, defaultWindowState, fitToDisplays, type WindowState } from '../window-state'

const DISPLAY = [{ x: 0, y: 0, width: 1920, height: 1080 }]

describe('fitToDisplays', () => {
  test('坐标在显示器内时原样保留', () => {
    const s: WindowState = { bounds: { x: 100, y: 100, width: 1280, height: 800 }, maximized: false }
    expect(fitToDisplays(s, DISPLAY)).toEqual(s)
  })

  test('bounds 在唯一显示器之外 → 没有 x/y，宽高保留', () => {
    const s: WindowState = { bounds: { x: 5000, y: 5000, width: 1280, height: 800 }, maximized: true }
    expect(fitToDisplays(s, DISPLAY)).toEqual({ bounds: { width: 1280, height: 800 }, maximized: true })
  })

  test('可见面积不足 100×100 也丢弃（贴边一点点）', () => {
    const s: WindowState = { bounds: { x: 1900, y: 1060, width: 1280, height: 800 }, maximized: false }
    expect(fitToDisplays(s, DISPLAY).bounds.x).toBeUndefined()
  })

  test('没有显示器（全部拔掉）→ 丢弃坐标', () => {
    const s: WindowState = { bounds: { x: 100, y: 100, width: 1280, height: 800 }, maximized: false }
    expect(fitToDisplays(s, []).bounds.x).toBeUndefined()
  })

  test('本来就没有坐标时不加坐标', () => {
    expect(fitToDisplays(defaultWindowState(), DISPLAY).bounds.x).toBeUndefined()
  })
})

describe('createWindowStateStore', () => {
  test('文件不存在 → 默认值', async () => {
    const dir = await tempDir('wstate-')
    const store = createWindowStateStore({
      file: path.join(dir.path, 'window-state.json'),
      logger: createTestLogger(),
      workAreas: () => DISPLAY,
    })
    expect(await store.load()).toEqual(defaultWindowState())
    await dir.dispose()
  })

  test('保存后读回（flush 立即落盘）', async () => {
    const dir = await tempDir('wstate-')
    const file = path.join(dir.path, 'window-state.json')
    const store = createWindowStateStore({
      file,
      logger: createTestLogger(),
      workAreas: () => DISPLAY,
      debounceMs: 60_000,
    })
    store.save({ bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: true })
    await store.flush()
    expect(await store.load()).toEqual({ bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: true })
    await dir.dispose()
  })

  test('宽 500 → schema 校验失败，回到默认值', async () => {
    const dir = await tempDir('wstate-')
    const file = path.join(dir.path, 'window-state.json')
    writeFileSync(file, JSON.stringify({ bounds: { width: 500, height: 400 }, maximized: false }))
    const store = createWindowStateStore({ file, logger: createTestLogger(), workAreas: () => DISPLAY })
    expect(await store.load()).toEqual(defaultWindowState())
    await dir.dispose()
  })

  test('坏 JSON → 默认值并记 warn', async () => {
    const dir = await tempDir('wstate-')
    const file = path.join(dir.path, 'window-state.json')
    writeFileSync(file, '{not json')
    const logger = createTestLogger()
    const store = createWindowStateStore({ file, logger, workAreas: () => DISPLAY })
    expect(await store.load()).toEqual(defaultWindowState())
    expect(logger.at('warn').length).toBeGreaterThan(0)
    await dir.dispose()
  })

  test('读回时应用 fitToDisplays（屏幕外的坐标被丢弃）', async () => {
    const dir = await tempDir('wstate-')
    const file = path.join(dir.path, 'window-state.json')
    writeFileSync(file, JSON.stringify({ bounds: { x: 9000, y: 9000, width: 1280, height: 800 }, maximized: false }))
    const store = createWindowStateStore({ file, logger: createTestLogger(), workAreas: () => DISPLAY })
    expect((await store.load()).bounds.x).toBeUndefined()
    await dir.dispose()
  })

  test('连续 save 只写一次（去抖 500ms）', async () => {
    const dir = await tempDir('wstate-')
    const file = path.join(dir.path, 'window-state.json')
    const store = createWindowStateStore({
      file,
      logger: createTestLogger(),
      workAreas: () => DISPLAY,
      debounceMs: 20,
    })
    await store.load()
    for (let i = 0; i < 10; i++) {
      store.save({ bounds: { x: i, y: 0, width: 1000, height: 700 }, maximized: false })
    }
    await Bun.sleep(60)
    await store.flush()
    expect((await store.load()).bounds.x).toBe(9)
    await dir.dispose()
  })
})
