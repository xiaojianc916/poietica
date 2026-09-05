import { expect, test } from 'bun:test'
import { importsOf } from './imports'
import { transportContractIsAdapterPrivate } from './policies'
import type { Workspace } from './workspace'

const workspaces: Workspace[] = [
  {
    name: '@poietica/automation',
    directory: 'packages/automation',
    manifest: { dependencies: { '@poietica/contract': 'workspace:*' } },
  },
]
const file = 'packages/automation/src/index.ts'

test('domain contracts are usable without exposing runtime transport', () => {
  const typed = importsOf(file, "import type { Automation } from '@poietica/contract/automation'")
  expect(transportContractIsAdapterPrivate(typed, workspaces)).toEqual([])
  for (const source of [
    "import { Automation } from '@poietica/contract/automation'",
    "import type { Automation } from '@poietica/contract'",
    "const contract = import('@poietica/contract/automation')",
  ]) {
    expect(transportContractIsAdapterPrivate(importsOf(file, source), workspaces)).toHaveLength(1)
  }
})
