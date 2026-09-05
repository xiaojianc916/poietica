import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import ts from '@typescript/typescript6'
import { analyzeSourceFiles, type SourceUnit } from './file-graph.ts'

const options: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
}
function inspect(sources: Record<string, string>, headless: readonly string[] = []) {
  const root = path.resolve('fixture')
  const files = new Map(
    Object.entries(sources).map(([file, code]) => [path.resolve(root, file), code]),
  )
  const units: SourceUnit[] = [...files].map(([file, code]) => ({ file, code, options }))
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => files.has(path.resolve(file)),
    readFile: (file) => files.get(path.resolve(file)),
  }
  return analyzeSourceFiles(
    root,
    units,
    host,
    headless.map((file) => path.resolve(root, file)),
  )
}

describe('production module graph', () => {
  test('relative imports participate in runtime cycle checks', () => {
    const result = inspect({
      'a.ts': "import { b } from './b'; export const a = () => b()",
      'b.ts': "import { a } from './a'; export const b = () => a()",
    })
    expect(result.some((item) => item.policy === 'runtime-file-cycle')).toBe(true)
  })
  test('a dynamic literal import cannot hide a cycle', () => {
    const result = inspect({
      'a.ts': "export const a = () => import('./b')",
      'b.ts': "export { a } from './a'",
    })
    expect(result.some((item) => item.policy === 'runtime-file-cycle')).toBe(true)
  })
  test('erased type dependencies are not runtime cycles', () => {
    expect(
      inspect({
        'a.ts': "import type { B } from './b'; export type A = { b?: B }",
        'b.ts': "import type { A } from './a'; export type B = { a?: A }",
      }),
    ).toEqual([])
  })
  test('a source containing only a computed import is still examined', () => {
    const result = inspect({ 'a.ts': 'export const load = (name: string) => import(name)' })
    expect(result.some((item) => item.policy === 'opaque-module-load')).toBe(true)
  })
  test('missing relative files are explicit errors', () => {
    const result = inspect({ 'a.ts': "export { missing } from './missing'" })
    expect(result.some((item) => item.policy === 'resolved-file-dependencies')).toBe(true)
  })
  test('headless entry restrictions follow transitive runtime dependencies', () => {
    const result = inspect(
      {
        'index.ts': "export { render } from './render'",
        'render.ts': "import { createElement } from 'react'; export const render = createElement",
      },
      ['index.ts'],
    )
    expect(result.some((item) => item.policy === 'headless-public-entry')).toBe(true)
  })
  test('an unimported UI surface does not taint its headless public entry', () => {
    expect(
      inspect(
        {
          'index.ts': 'export const compute = () => 42',
          'surface.ts':
            "import { createElement } from 'react'; export const render = createElement",
        },
        ['index.ts'],
      ),
    ).toEqual([])
  })
})
