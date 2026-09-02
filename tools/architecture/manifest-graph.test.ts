import { expect, test } from 'bun:test'
import { manifestBoundaries } from './manifest-graph.ts'
import type { Workspace } from './workspace.ts'

const workspace = (name: string, directory: string, dependencies = {}): Workspace => ({
  name,
  directory,
  manifest: { name, dependencies },
})

test('manifest graph rejects an upward dependency without a source import', () => {
  const violations = manifestBoundaries([
    workspace('@poietica/conversation', 'packages/conversation', {
      '@poietica/assistant': 'workspace:*',
    }),
    workspace('@poietica/assistant', 'packages/assistant'),
  ])
  expect(violations.some((item) => item.policy === 'manifest-boundaries')).toBe(true)
})

test('manifest graph rejects cycles in unlayered workspaces', () => {
  const violations = manifestBoundaries([
    workspace('@poietica/tools', 'tools', { '@poietica/tests': 'workspace:*' }),
    workspace('@poietica/tests', 'tests', { '@poietica/tools': 'workspace:*' }),
  ])
  expect(violations.some((item) => item.policy === 'manifest-no-cycles')).toBe(true)
})
