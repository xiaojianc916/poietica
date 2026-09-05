import { expect, test } from 'bun:test'
import type { ImportRecord } from './imports.ts'
import { publicEntryOnly } from './policies.ts'
import type { Workspace } from './workspace.ts'

const leaf: Workspace = {
  name: '@poietica/fixture',
  directory: 'fixture',
  manifest: { exports: { './feature': './feature.ts' } },
}
const record = (specifier: string): ImportRecord => ({ file: 'consumer.ts', specifier })

test('package roots are not implicitly public', () => {
  expect(publicEntryOnly([record('@poietica/fixture')], [leaf])).toHaveLength(1)
})
test('declared subpaths are public and internal paths are not', () => {
  expect(publicEntryOnly([record('@poietica/fixture/feature')], [leaf])).toHaveLength(0)
  expect(publicEntryOnly([record('@poietica/fixture/internal')], [leaf])).toHaveLength(1)
})
test('an explicitly declared package root remains valid', () => {
  const declared: Workspace = { ...leaf, manifest: { exports: { '.': './entry.ts' } } }
  expect(publicEntryOnly([record('@poietica/fixture')], [declared])).toHaveLength(0)
})
