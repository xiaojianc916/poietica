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
import {
  DESCRIPTIONS,
  hasDescriptionTranslation,
  settingDescriptionOf,
} from '../settings-descriptions.ts'

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

test('the merged table carries no duplicate key', async () => {
  /*
   * 表是一张对象字面量，重复键在运行时已不可见，只可能存在于源码里：逐行取键名断言唯一。
   * （biome 的 noDuplicateObjectKeys 也在 lint 层钉同一件事，这里是第二道闸。）
   */
  const source = await Bun.file(new URL('../settings-descriptions.ts', import.meta.url)).text()
  const keys = [...source.matchAll(/^[ \t]*(?:'([A-Za-z0-9_.-]+)'|([A-Za-z0-9_.-]+)):/gm)].map(
    (match) => match[1] ?? match[2]!,
  )

  /* 正则失守（比如格式化改了键的写法）时这个数会塌下去，断言不许空转。 */
  expect(keys.length).toBeGreaterThan(300)
  expect(new Set(keys).size).toBe(keys.length)
})

test('every table key is a setting omp actually publishes on screen', () => {
  /*
   * 判据取自 omp 的 schema（正本），而不是我们那份过滤后的目录：过滤规则会随判断改，
   * 上游那张表不会。认得出 ui 元数据的才算上屏的格子。
   */
  const invented = Object.keys(DESCRIPTIONS).filter((path) => getUi(path as never) === undefined)

  expect(invented).toEqual([])
})
