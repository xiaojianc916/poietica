import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import ts from '@typescript/typescript6'
import { conversationBoundaries, conversationCore } from './conversation-boundaries.ts'
import { analyzeSourceFiles, type SourceUnit } from './file-graph.ts'
import type { Violation } from './policies.ts'

const root = path.resolve('architecture-fixture')
const directory = path.join(root, 'packages', 'conversation', 'src')
function inspect(input: Readonly<Record<string, string>>): Violation[] {
  const options: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    baseUrl: directory,
    paths: { '#view': ['surface/view.ts'] },
  }
  const units: SourceUnit[] = Object.entries(input).map(([file, code]) => ({
    file: path.join(directory, file),
    code,
    options,
  }))
  const content = new Map(units.map((unit) => [unit.file, unit.code]))
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => content.has(path.resolve(file)),
    readFile: (file) => content.get(path.resolve(file)),
    directoryExists: () => true,
    getCurrentDirectory: () => root,
  }
  const violations = units.flatMap((unit) =>
    conversationBoundaries(root, unit.file, unit.file, true),
  )
  const headless = units
    .filter((unit) => conversationCore(root, unit.file))
    .map((unit) => unit.file)
  violations.push(
    ...analyzeSourceFiles(
      root,
      units,
      host,
      headless,
      new Map(),
      (file, _specifier, target, typeOnly) => {
        violations.push(...conversationBoundaries(root, file, target, typeOnly))
      },
      (file) => conversationCore(root, file),
    ),
  )
  return violations
}

describe('conversation responsibility boundaries', () => {
  it('permits pure projection and view consumption without an aggregate dependency', () => {
    expect(
      inspect({
        'agent/event.ts': 'export interface Event { value: string }',
        'timeline/projection.ts':
          "import type { Event } from '../agent/event'; export const project = (event: Event) => event.value",
        'surface/view.ts':
          "import { project } from '../timeline/projection'; export const view = project",
      }),
    ).toEqual([])
  })
  it('rejects a type-only upward edge resolved through an alias', () => {
    const result = inspect({
      'composer/input.ts': "import type { View } from '#view'; export type Input = View",
      'surface/view.ts': 'export interface View { text: string }',
    })
    expect(result.some((item) => item.policy === 'conversation-responsibility-direction')).toBe(
      true,
    )
  })
  it('reports knowledge cycles separately from runtime cycles', () => {
    const result = inspect({
      'composer/first.ts':
        "import type { Second } from './second'; export interface First { next?: Second }",
      'composer/second.ts':
        "import type { First } from './first'; export interface Second { next?: First }",
    })
    expect(result.some((item) => item.policy === 'core-file-dependency-cycle')).toBe(true)
    expect(result.some((item) => item.policy === 'runtime-file-cycle')).toBe(false)
  })
  it('allows configuration to hand off through a contract but not import a transcript owner', () => {
    expect(
      inspect({
        'configuration/selection.ts':
          "import type { Sink } from '../transcript/transcript-sink'; export type Output = Sink",
        'transcript/transcript-sink.ts': 'export interface Sink { opened(): void }',
      }),
    ).toEqual([])
    const result = inspect({
      'configuration/selection.ts':
        "import type { Store } from '../transcript/store'; export type Output = Store",
      'transcript/store.ts': 'export interface Store { opened(): void }',
    })
    expect(result.some((item) => item.policy === 'conversation-responsibility-direction')).toBe(
      true,
    )
  })
  it('checks an unexported core file for framework coupling', () => {
    const result = inspect({
      'composer/input.ts': "import type { ReactNode } from 'react'; export type Input = ReactNode",
    })
    expect(result.some((item) => item.policy === 'headless-public-entry')).toBe(true)
  })
})
