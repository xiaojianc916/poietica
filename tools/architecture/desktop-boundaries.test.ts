import { expect, test } from 'bun:test'
import path from 'node:path'
import ts from '@typescript/typescript6'
import { desktopBoundaries } from './desktop-boundaries.ts'
import { analyzeSourceFiles } from './file-graph.ts'

const root = path.resolve('/architecture-fixture')
const file = (relative: string): string =>
  path.join(root, 'apps', 'desktop', 'src', relative).split(path.sep).join('/')

test('composition is the only consumer that may connect all desktop domains', () => {
  expect(
    desktopBoundaries(root, file('entry/app-shell.tsx'), file('assistant/assistant-pane.tsx')),
  ).toEqual([])
  expect(
    desktopBoundaries(root, file('shell/layout/workspace-shell.tsx'), file('entry/app-shell.tsx')),
  ).toHaveLength(1)
  expect(
    desktopBoundaries(
      root,
      file('window/use-window-chrome.ts'),
      file('shell/chrome/title-bar.tsx'),
    ),
  ).toHaveLength(1)
  expect(
    desktopBoundaries(
      root,
      file('assistant/conversation-surface.tsx'),
      file('shell/layout/layout-context.ts'),
    ),
  ).toHaveLength(1)
})

test('shell capabilities have direction rather than a permissive same-package exemption', () => {
  expect(
    desktopBoundaries(
      root,
      file('shell/chrome/title-bar.tsx'),
      file('shell/layout/layout-context.ts'),
    ),
  ).toEqual([])
  expect(
    desktopBoundaries(
      root,
      file('shell/layout/layout-store.ts'),
      file('shell/chrome/title-bar.tsx'),
    ),
  ).toHaveLength(1)
  expect(
    desktopBoundaries(root, file('shell/tabs/workbench-tabs.tsx'), file('shell/index.ts')),
  ).toHaveLength(1)
})

test('resolved aliases and erased imports cannot bypass desktop direction', () => {
  const caller = file('assistant/consumer.ts')
  const target = file('entry/owner.ts')
  const sources = new Map([
    [caller, "import type { Owner } from '@composition/owner'; export type Input = Owner"],
    [target, 'export interface Owner { readonly value: string }'],
  ])
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: root,
    paths: { '@composition/*': ['apps/desktop/src/entry/*'] },
  }
  const findings: ReturnType<typeof desktopBoundaries> = []
  analyzeSourceFiles(
    root,
    [...sources].map(([file, code]) => ({ file, code, options })),
    {
      fileExists: (file) => sources.has(file),
      readFile: (file) => sources.get(file),
    },
    [],
    new Map(),
    (file, _specifier, target) => {
      findings.push(...desktopBoundaries(root, file, target))
    },
  )
  expect(findings).toHaveLength(1)
  expect(findings[0]?.policy).toBe('desktop-domain-direction')
})
