import { expect, test } from 'bun:test'
import path from 'node:path'
import ts from '@typescript/typescript6'
import { analyzeSourceFiles } from './file-graph.ts'
import { settingsBoundaries, settingsCore } from './settings-boundaries.ts'

const root = path.resolve('settings-boundary-fixture')
const file = (name: string) => path.join(root, 'packages/settings/src', name)
test('settings responsibilities permit only inward dependencies', () => {
  expect(
    settingsBoundaries(root, file('preferences/session.ts'), file('preferences/store.ts')),
  ).toHaveLength(0)
  expect(
    settingsBoundaries(root, file('preferences/store.ts'), file('preferences/session.ts')),
  ).toHaveLength(1)
  expect(
    settingsBoundaries(
      root,
      file('agent-runtime/settings.ts'),
      file('agent-runtime/repository.ts'),
    ),
  ).toHaveLength(0)
  expect(
    settingsBoundaries(root, file('agent-runtime/model.ts'), file('agent-runtime/settings.ts')),
  ).toHaveLength(1)
  expect(
    settingsBoundaries(root, file('model-metadata/models-dev.ts'), file('model-catalog/store.ts')),
  ).toHaveLength(1)
  expect(settingsBoundaries(root, file('preferences/store.ts'), file('index.ts'))).toHaveLength(1)
  expect(
    settingsBoundaries(root, file('preferences/store.ts'), file('ui/surface/settings-surface.tsx')),
  ).toHaveLength(1)
})
test('type-only cycles are rejected inside settings core', () => {
  const documents = new Map([
    [file('preferences/store.ts'), "export type { B } from './session'; export interface A {}"],
    [file('preferences/session.ts'), "export type { A } from './store'; export interface B {}"],
  ])
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }
  const units = [...documents].map(([file, code]) => ({ file, code, options }))
  /* TS 解析用正斜杠探测，与 Map 的 path.join 反斜杠键分隔符不同，须归一。 */
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => documents.has(path.resolve(file)),
    readFile: (file) => documents.get(path.resolve(file)),
  }
  const findings = analyzeSourceFiles(
    root,
    units,
    host,
    [],
    new Map(),
    () => {},
    (file) => settingsCore(root, file),
  )
  expect(findings.some((finding) => finding.policy === 'core-file-dependency-cycle')).toBe(true)
})
