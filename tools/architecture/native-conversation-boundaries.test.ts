import { expect, test } from 'bun:test'
import path from 'node:path'
import ts from '@typescript/typescript6'
import { analyzeSourceFiles } from './file-graph.ts'
import { nativeConversationBoundaries } from './native-conversation-boundaries.ts'

const root = path.resolve('/architecture-fixture')
const file = (name: string): string =>
  path
    .join(root, 'packages', 'native-bridge', 'src', 'conversation', name)
    .split(path.sep)
    .join('/')

test('native port implementations consume leaf decoding but never their facade', () => {
  expect(
    nativeConversationBoundaries(root, file('session.ts'), file('transcript-decoding.ts')),
  ).toEqual([])
  expect(
    nativeConversationBoundaries(root, file('transcript-decoding.ts'), file('session.ts')),
  ).toHaveLength(1)
  expect(nativeConversationBoundaries(root, file('threads.ts'), file('index.ts'))).toHaveLength(1)
  expect(nativeConversationBoundaries(root, file('index.ts'), file('threads.ts'))).toEqual([])
})

test('native direction also applies to resolved aliases and erased imports', () => {
  const caller = file('selectors.ts')
  const target = file('session.ts')
  const sources = new Map([
    [caller, "import type { Input } from '@conversation/session'; export type Value = Input"],
    [target, 'export interface Input { readonly value: string }'],
  ])
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: root,
    paths: {
      '@conversation/*': ['packages/native-bridge/src/conversation/*'],
    },
  }
  const findings: ReturnType<typeof nativeConversationBoundaries> = []
  analyzeSourceFiles(
    root,
    [...sources].map(([file, code]) => ({ file, code, options })),
    { fileExists: (file) => sources.has(file), readFile: (file) => sources.get(file) },
    [],
    new Map(),
    (file, _specifier, target) => {
      findings.push(...nativeConversationBoundaries(root, file, target))
    },
  )
  expect(findings).toHaveLength(1)
  expect(findings[0]?.policy).toBe('native-conversation-direction')
})
