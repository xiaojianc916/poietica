/*
 * 设置目录的两条判据，一条都不许松：
 *
 * 1. 目录是**从 omp 的 schema 读出来的**，不是我们抄的 —— 所以它的条数与标签必须与
 *    上游此刻的自报一致。抄一份的代码会在上游加一格时静默落后，而这一条会红。
 * 2. 钥匙那一格绝不带值。这是隐私边界，写错就是把用户的钥匙送到 webview。
 *
 * 自检跑法：bun test src/__tests__/settings.test.ts
 */

import { expect, test } from 'bun:test'
import {
  getUi,
  hasUi,
  SETTINGS_SCHEMA,
  type SettingPath,
} from '@oh-my-pi/pi-coding-agent/config/settings-schema'
import { readCatalog, SETTING_TABS } from '../settings.ts'

/** 一个假 reader：给什么回什么，用来钉住「目录不读我们的状态」。 */
function reader(values: Record<string, unknown> = {}): { get(key: string): unknown } {
  return { get: (key) => values[key] }
}

test('the catalog is omp own schema, not a copy in our source', () => {
  const all = readCatalog(reader())
  const expected = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter((path) => hasUi(path))

  // 条数必须等于上游自报的带 ui 元数据的那几格。差一条就说明两边分叉了。
  expect(all.length).toBe(expected.length)
  expect(all.length).toBeGreaterThan(300)

  // 每一格的标签都来自上游，逐格核对；顺带证明我们没有自己编过一份文案。
  for (const entry of all) {
    const ui = getUi(entry.path as SettingPath)

    if (ui === undefined) {
      throw new Error(`catalog carries ${entry.path}, which has no ui metadata upstream`)
    }

    expect(entry.label).toBe(ui.label)
    expect(entry.description).toBe(ui.description)
  }
})

test('a tab filter returns exactly that tab', () => {
  for (const tab of SETTING_TABS) {
    const entries = readCatalog(reader(), tab)
    expect(entries.every((entry) => entry.tab === tab)).toBe(true)
  }

  // 十栏加起来就是全部：没有哪一格被漏掉或重复。
  const summed = SETTING_TABS.reduce((total, tab) => total + readCatalog(reader(), tab).length, 0)
  expect(summed).toBe(readCatalog(reader()).length)
})

test('a credential never carries its value, only whether it is set', () => {
  const secretPath = 'mnemopi.llmApiKey'
  const planted = 'sk-do-not-leak-this-key'

  const entry = readCatalog(reader({ [secretPath]: planted })).find(
    (candidate) => candidate.path === secretPath,
  )

  expect(entry?.secret).toBe(true)
  // 值那一格必须缺席；配过没有由布尔那一格说。
  expect(entry?.value).toBeNull()
  expect(entry?.hasValue).toBe(true)
  // 整份载荷里一个字都不许出现 —— 序列化之后再查一次，防止将来加格时漏掉。
  expect(JSON.stringify(readCatalog(reader({ [secretPath]: planted })))).not.toContain(planted)
})

test('an unset or blank credential reads as not configured, not as configured', () => {
  const secretPath = 'mnemopi.llmApiKey'
  const at = (values: Record<string, unknown>) =>
    readCatalog(reader(values)).find((entry) => entry.path === secretPath)?.hasValue

  expect(at({})).toBe(false)
  expect(at({ [secretPath]: '' })).toBe(false)
  expect(at({ [secretPath]: '   ' })).toBe(false)
  expect(at({ [secretPath]: 'sk-real' })).toBe(true)
})

test('a normal setting carries its current value, and a runtime-option enum carries none', () => {
  const entries = readCatalog(reader({ 'browser.headless': false }))

  const headless = entries.find((entry) => entry.path === 'browser.headless')
  expect(headless?.type).toBe('boolean')
  expect(headless?.value).toBe(false)
  expect(headless?.secret).toBe(false)

  /*
   * `theme.dark` 的选项是 `'runtime'`（要现算），不是一张固定表：那一格如实没有 options，
   * 而不是编一张空表骗界面画一个空下拉。
   */
  const theme = entries.find((entry) => entry.path === 'theme.dark')
  expect(theme?.options).toBeUndefined()
})
