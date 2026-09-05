import { expect, test } from 'bun:test'
import { importsOf, valueBindingsOf } from './imports'

test('reads real TypeScript module edges without rewriting the source', () => {
  const source = [
    '#!/usr/bin/env bun',
    "import type { Shape } from './shape'",
    "export type { Detail } from './detail'",
    "export { item } from './item'",
    "type Imported = import('./imported').Value",
    "import assigned = require('./assigned')",
    "const lazy = import('./lazy')",
    "const loaded = require('./loaded')",
    "const note = 'import type Fake from ignored'",
    "// import Ghost from './ghost'",
  ].join('\n')
  expect(importsOf('fixture.ts', source).map((record) => record.specifier)).toEqual([
    './shape',
    './detail',
    './item',
    './imported',
    './assigned',
    './lazy',
    './loaded',
  ])
})

test('a TSX source and mixed type/value aliases retain their real meaning', () => {
  const source = [
    "import { type Shape, Store as Renamed } from './scope'",
    'const element = <section />',
  ].join('\n')
  expect(importsOf('fixture.tsx', source)).toEqual([{ file: 'fixture.tsx', specifier: './scope' }])
  expect(valueBindingsOf('fixture.tsx', source)).toEqual([{ specifier: './scope', name: 'Store' }])
})

test('marks only erased module edges as type-only', () => {
  expect(importsOf('scope.ts', "import type { Shape } from './shape'")).toEqual([
    { file: 'scope.ts', specifier: './shape', typeOnly: true },
  ])
  expect(importsOf('scope.ts', "export type { Shape } from './shape'")).toEqual([
    { file: 'scope.ts', specifier: './shape', typeOnly: true },
  ])
  expect(importsOf('scope.ts', "const value = import('./shape')")).toEqual([
    { file: 'scope.ts', specifier: './shape' },
  ])
})
