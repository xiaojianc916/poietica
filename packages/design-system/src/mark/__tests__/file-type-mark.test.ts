import { expect, test } from 'bun:test'
import { fileMarkIdOf, knownFileMarkOf } from '../file-type-mark'

/*
 * 只钉**优先次序**，不抄映射表：整名优先于后缀，路径规则夹在两者之间，后缀先长后短。
 * 每一条都是「同一族里两个来源都命中时谁赢」，改的是其中一张表时这几条不会一起变红。
 */

test('整名优先于后缀：package.json 是 nodejs，不是 json；bunfig.toml 是 bun，不是 toml', () => {
  expect(fileMarkIdOf('package.json')).toBe('nodejs')
  expect(fileMarkIdOf('bunfig.toml')).toBe('bun')
})

test('路径规则优先于后缀：vite.config.ts 是 vite，落在子目录里也认', () => {
  expect(fileMarkIdOf('vite.config.ts')).toBe('vite')
  expect(fileMarkIdOf('apps/desktop/electron.vite.config.ts')).toBe('vite')
})

test('后缀先长后短：index.d.ts 是 typescript-def，不被 .ts 抢走', () => {
  expect(fileMarkIdOf('index.d.ts')).toBe('typescript-def')
  expect(fileMarkIdOf('history-legacy.test.ts.snap')).toBe('test-ts')
})

test('认不出来是通用文档；knownFileMarkOf 答「不知道」而不是退回文档', () => {
  expect(fileMarkIdOf('note.unknownext')).toBe('document')
  expect(knownFileMarkOf('note.unknownext')).toBeUndefined()
  expect(knownFileMarkOf('main.rs')).toBe('rust')
})
