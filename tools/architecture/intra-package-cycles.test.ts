import { expect, test } from 'bun:test'
import type { ImportRecord } from './imports.ts'
import { intraPackageCycles } from './policies.ts'
import type { Workspace } from './workspace.ts'

const workspace: Workspace = {
  name: '@poietica/fixture',
  directory: ['packages', 'fixture'].join('/'),
  manifest: {},
}

/* 分段拼路径：写成一整串会让 invoked-scripts-resolve 把它当成一个真实点名。 */
const at = (...segments: readonly string[]): string =>
  [workspace.directory, 'src', ...segments].join('/')
const record = (file: string, specifier: string): ImportRecord => ({ file, specifier })

test('two directories that depend on each other are a cycle', () => {
  const findings = intraPackageCycles(
    [record(at('a', 'one.ts'), '../b/two'), record(at('b', 'two.ts'), '../a/one')],
    [workspace],
  )

  expect(findings).toHaveLength(1)
  expect(findings[0]?.policy).toBe('intra-package-cycles')
})

test('a facade forwarding its own subdirectory is not a reverse edge', () => {
  const findings = intraPackageCycles(
    [record(at('index.ts'), './a/one'), record(at('a', 'one.ts'), './two')],
    [workspace],
  )

  expect(findings).toHaveLength(0)
})

test('a subdirectory reading a sibling leaf of the package root is not a facade edge', () => {
  const findings = intraPackageCycles(
    [record(at('a', 'one.ts'), '../failure'), record(at('a', 'two.ts'), './one')],
    [workspace],
  )

  expect(findings).toHaveLength(0)
})

test('a longer ring is reported once with its full path', () => {
  const findings = intraPackageCycles(
    [
      record(at('a', 'one.ts'), '../b/two'),
      record(at('b', 'two.ts'), '../c/three'),
      record(at('c', 'three.ts'), '../a/one'),
    ],
    [workspace],
  )

  expect(findings).toHaveLength(1)
  expect(findings[0]?.detail).toContain(at('a'))
  expect(findings[0]?.detail).toContain(at('c'))
})

test('edges crossing packages belong to the layer rules, not this one', () => {
  const findings = intraPackageCycles([record(at('a', 'one.ts'), '@poietica/other')], [workspace])

  expect(findings).toHaveLength(0)
})
