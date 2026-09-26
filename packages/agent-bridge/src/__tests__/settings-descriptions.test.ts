/*
 * 设置说明的判据。
 *
 * 两条，缺一条这张表就会静默烂掉：
 *
 * 1. **上屏的每一格都有中文说明。** 少一格就是那一行底下留着英文 —— 而英文混在中文里
 *    人一眼看得出，代码里却看不出，所以要有测试盯着。
 * 2. **译稿里没有多余、没有重复的键。** 这一条是被真实缺陷逼出来的：一位译者凭印象
 *    多写了三个上游根本没有的键（`startup.changelogMode` 这类）。`biome` 与肉眼都发现
 *    不了它，只有拿键集双向比对才现形。多余的键不会显示，但它会让「有没有漏译」这个
 *    判断失真。
 *
 * 自检跑法：bun test src/__tests__/settings-descriptions.test.ts
 */

import { expect, test } from 'bun:test'
import { getUi } from '@oh-my-pi/pi-coding-agent/config/settings-schema'
import { readCatalog } from '../settings.ts'
import { DESCRIPTIONS_A } from '../settings-descriptions.a.ts'
import { DESCRIPTIONS_B } from '../settings-descriptions.b.ts'
import { DESCRIPTIONS_C } from '../settings-descriptions.c.ts'
import { hasDescriptionTranslation, settingDescriptionOf } from '../settings-descriptions.ts'

/** 上屏那一批：omp 自报带 ui 元数据、且跟这台桌面软件有关。 */
const visiblePaths = (): string[] =>
  readCatalog({ get: () => undefined }, null).map((entry) => entry.path)

test('every setting on screen carries a Chinese description', () => {
  const paths = visiblePaths()
  expect(paths.length).toBeGreaterThan(300)

  /* 报出具体是哪些格：只报条数的话，修的时候还得自己再找一遍。 */
  const untranslated = paths.filter((path) => !hasDescriptionTranslation(path))

  expect(untranslated).toEqual([])
})

test('a description that is not ours falls back to the English original, never to a blank', () => {
  expect(settingDescriptionOf('no.such.setting', 'Original English')).toBe('Original English')
  expect(settingDescriptionOf('no.such.setting', '')).toBe('')
  expect(hasDescriptionTranslation('no.such.setting')).toBe(false)
})

test('the three shards carry no duplicate and no invented key', () => {
  const shards: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    ['a', DESCRIPTIONS_A],
    ['b', DESCRIPTIONS_B],
    ['c', DESCRIPTIONS_C],
  ]

  const owner = new Map<string, string>()
  const duplicates: string[] = []

  for (const [letter, table] of shards) {
    for (const key of Object.keys(table)) {
      const first = owner.get(key)

      if (first !== undefined) {
        duplicates.push(`${key} (${first} 与 ${letter})`)
      }

      owner.set(key, letter)
    }
  }

  expect(duplicates).toEqual([])
})

test('every shard key is a setting omp actually publishes on screen', () => {
  /*
   * 判据取自 omp 的 schema（正本），而不是我们那份过滤后的目录：过滤规则会随判断改，
   * 上游那张表不会。认得出 ui 元数据的才算上屏的格子。
   */
  const invented = Object.keys({
    ...DESCRIPTIONS_A,
    ...DESCRIPTIONS_B,
    ...DESCRIPTIONS_C,
  }).filter((path) => getUi(path as never) === undefined)

  expect(invented).toEqual([])
})
