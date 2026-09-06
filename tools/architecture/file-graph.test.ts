import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import ts from '@typescript/typescript6'
import { analyzeSourceFiles, resolvedWorkspaceBoundaries, type SourceUnit } from './file-graph.ts'
import type { Violation } from './policies.ts'
import type { Workspace } from './workspace.ts'

const options: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
}
function inspect(
  sources: Record<string, string>,
  headless: readonly string[] = [],
  entries: ReadonlyMap<string, Workspace> = new Map(),
) {
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
    entries,
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

const workspaceEntries = new Map<string, Workspace>([
  [
    '@poietica/a',
    {
      name: '@poietica/a',
      directory: 'a',
      manifest: { name: '@poietica/a', exports: { '.': './index.ts' } },
    },
  ],
  [
    '@poietica/b',
    {
      name: '@poietica/b',
      directory: 'b',
      manifest: { name: '@poietica/b', exports: { '.': './index.ts' } },
    },
  ],
])

describe('workspace entries without installation links', () => {
  test('resolved public exports participate in runtime cycles', () => {
    const result = inspect(
      {
        'a/index.ts': "export { b } from '@poietica/b'; export const a = 1",
        'b/index.ts': "export { a } from '@poietica/a'; export const b = 2",
      },
      [],
      workspaceEntries,
    )
    expect(result.some((item) => item.policy === 'runtime-file-cycle')).toBe(true)
  })
  test('headless validation crosses a workspace public entry', () => {
    const result = inspect(
      {
        'a/index.ts': "export { view } from '@poietica/b'",
        'b/index.ts': "import { createElement } from 'react'; export const view = createElement",
      },
      ['a/index.ts'],
      workspaceEntries,
    )
    expect(result.some((item) => item.policy === 'headless-public-entry')).toBe(true)
  })
  test('erased workspace type dependencies do not become runtime cycles', () => {
    const result = inspect(
      {
        'a/index.ts': "import type { B } from '@poietica/b'; export type A = { b?: B }",
        'b/index.ts': "import type { A } from '@poietica/a'; export type B = { a?: A }",
      },
      [],
      workspaceEntries,
    )
    expect(result).toEqual([])
  })
})

const resolvedEntries = new Map<string, Workspace>([
  [
    '@poietica/conversation',
    {
      name: '@poietica/conversation',
      directory: 'packages/conversation',
      manifest: {
        name: '@poietica/conversation',
        exports: { '.': './src/index.ts' },
        dependencies: { '@poietica/contract': 'workspace:*' },
      },
    },
  ],
  [
    '@poietica/native-bridge',
    {
      name: '@poietica/native-bridge',
      directory: 'packages/native-bridge',
      manifest: {
        name: '@poietica/native-bridge',
        exports: { '.': './src/index.ts' },
        dependencies: { '@poietica/conversation': 'workspace:*' },
      },
    },
  ],
  [
    '@poietica/contract',
    {
      name: '@poietica/contract',
      directory: 'packages/contract',
      manifest: {
        name: '@poietica/contract',
        exports: {
          '.': './src/generated/ipc-bindings.ts',
          './conversation': './src/conversation.ts',
        },
      },
    },
  ],
])
const fixtureSource = (domain: string, file: string) => ['packages', domain, 'src', file].join('/')
const conversationEntry = fixtureSource('conversation', 'index.ts')
const conversationPrivate = fixtureSource('conversation', 'private.ts')
const nativeEntry = fixtureSource('native-bridge', 'index.ts')
const wireEntry = fixtureSource('contract', 'generated/ipc-bindings.ts')
const conversationContract = fixtureSource('contract', 'conversation.ts')
function inspectResolved(sources: Record<string, string>, paths: Record<string, string[]>) {
  const root = path.resolve('fixture')
  const files = new Map(
    Object.entries(sources).map(([file, text]) => [path.resolve(root, file), text]),
  )
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => files.has(path.resolve(file)),
    readFile: (file) => files.get(path.resolve(file)),
  }
  const units: SourceUnit[] = [...files].map(([file, text]) => ({
    file,
    code: text,
    options: { ...options, baseUrl: root, paths },
  }))
  const policy = resolvedWorkspaceBoundaries(root, [...resolvedEntries.values()], host)
  const boundaries: Violation[] = []
  const graph = analyzeSourceFiles(
    root,
    units,
    host,
    [],
    resolvedEntries,
    (file, specifier, target, typeOnly) => {
      boundaries.push(...policy(file, specifier, target, typeOnly))
    },
  )
  return [...graph, ...boundaries]
}

describe('resolved workspace ownership', () => {
  test('a paths alias cannot enter another package through a private source', () => {
    const found = inspectResolved(
      {
        [nativeEntry]: "export { value } from '#conversation'",
        [conversationPrivate]: 'export const value = 1',
      },
      { '#conversation': [conversationPrivate] },
    )
    expect(found.some((entry) => entry.policy === 'resolved-public-entry')).toBe(true)
  })
  test('an alias cannot hide an upward type dependency', () => {
    const found = inspectResolved(
      {
        [conversationEntry]: "import type { Host } from '#host'; export type Input = Host",
        [nativeEntry]: 'export type Host = { value: string }',
      },
      { '#host': [nativeEntry] },
    )
    expect(found.some((entry) => entry.policy === 'layer-direction')).toBe(true)
    expect(found.some((entry) => entry.policy === 'resolved-declared-dependency')).toBe(true)
  })
  test('an alias to a declared downward public entry remains legal', () => {
    expect(
      inspectResolved(
        {
          [nativeEntry]: "export { value } from '#conversation'",
          [conversationEntry]: 'export const value = 1',
        },
        { '#conversation': [conversationEntry] },
      ),
    ).toEqual([])
  })
  test('runtime transport cannot hide behind a contract alias', () => {
    const found = inspectResolved(
      {
        [conversationEntry]: "export { commands } from '#wire'",
        [wireEntry]: 'export const commands = {}',
      },
      { '#wire': [wireEntry] },
    )
    expect(found.some((entry) => entry.policy === 'transport-contract-is-adapter-private')).toBe(
      true,
    )
  })
  test('the declared type-only domain contract remains legal through an alias', () => {
    expect(
      inspectResolved(
        {
          [conversationEntry]: "import type { Thread } from '#thread'; export type Value = Thread",
          [conversationContract]: 'export type Thread = { id: string }',
        },
        { '#thread': [conversationContract] },
      ),
    ).toEqual([])
  })
})

test('host integration cannot enter a view through a public path or alias', () => {
  const root = path.resolve('fixture')
  const conversation: Workspace = {
    name: '@poietica/conversation',
    directory: 'packages/conversation',
    manifest: {
      exports: { '.': './src/index.ts', './surface': './src/surface.ts' },
      poietica: { headless: ['.'] },
    },
  }
  const bridge: Workspace = {
    name: '@poietica/native-bridge',
    directory: 'packages/native-bridge',
    manifest: { dependencies: { '@poietica/conversation': 'workspace:*' } },
  }
  const host: ts.ModuleResolutionHost = { fileExists: () => true, readFile: () => '' }
  const policy = resolvedWorkspaceBoundaries(root, [conversation, bridge], host)
  const from = path.resolve(root, nativeEntry)
  const view = path.resolve(root, fixtureSource('conversation', 'surface.ts'))
  for (const name of ['@poietica/conversation/surface', '#conversation-view']) {
    expect(
      policy(from, name, view, false).some((item) => item.policy === 'headless-host-dependency'),
    ).toBe(true)
  }
  expect(
    policy(from, '@poietica/conversation', path.resolve(root, conversationEntry), false),
  ).toEqual([])
})

test('runtime graph follows source exports rather than stopping at declaration files', () => {
  const root = path.resolve('fixture')
  const records = new Map<string, string>([
    [path.resolve(root, 'entry.ts'), "export { render } from '@poietica/rendering'"],
    [path.resolve(root, 'rendering/index.d.ts'), 'export declare const render: unknown'],
    [
      path.resolve(root, 'rendering/index.ts'),
      "import { createElement } from 'react'; export const render = createElement",
    ],
  ])
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => records.has(path.resolve(file)),
    readFile: (file) => records.get(path.resolve(file)),
  }
  const configured = {
    ...options,
    baseUrl: root,
    paths: { '@poietica/rendering': ['rendering/index.d.ts'] },
  }
  const units: SourceUnit[] = [...records].map(([file, code]) => ({
    file,
    code,
    options: configured,
  }))
  const entries = new Map<string, Workspace>([
    [
      '@poietica/rendering',
      {
        name: '@poietica/rendering',
        directory: 'rendering',
        manifest: { exports: { '.': { types: './index.d.ts', default: './index.ts' } } },
      },
    ],
  ])
  const found = analyzeSourceFiles(root, units, host, [path.resolve(root, 'entry.ts')], entries)
  expect(found.some((item) => item.policy === 'headless-public-entry')).toBe(true)
})
