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
  expect(settingsBoundaries(root, file('preferences/store.ts'), file('index.ts'))).toHaveLength(1)
  expect(
    settingsBoundaries(root, file('preferences/store.ts'), file('ui/surface/settings-surface.tsx')),
  ).toHaveLength(1)
})
/*
 * 新目录必须先在这张表里声明自己归谁管（AGENTS.md §7「加一个包：先在分层表定层」，
 * 下移一层）。没有声明就直接被拒 —— 这一条会在「加目录时忘了登记」的第一时间红，
 * 而不是等到十几条方向违规之后才由人反推原因。
 */
test('a directory with no declared responsibility is rejected outright', () => {
  expect(settingsBoundaries(root, file('not-a-declared-dir/x.ts'), file('index.ts'))).toHaveLength(
    1,
  )
  expect(settingsBoundaries(root, file('index.ts'), file('not-a-declared-dir/x.ts'))).toHaveLength(
    1,
  )
})
test('the agent-settings domain is reachable from the public edge and the ui, and only inward', () => {
  // 公开边与界面都要能读到它：前者是包的出口，后者是画它的那一侧。
  expect(settingsBoundaries(root, file('index.ts'), file('agent-settings/store.ts'))).toHaveLength(
    0,
  )
  expect(
    settingsBoundaries(
      root,
      file('ui/agent-settings/agent-settings.tsx'),
      file('agent-settings/store.ts'),
    ),
  ).toHaveLength(0)
  // 域内只依赖自己：反向读到别的域，或者核心目录回头去拿包的出口（那是环）。
  expect(
    settingsBoundaries(root, file('agent-settings/store.ts'), file('preferences/store.ts')),
  ).toHaveLength(1)
  expect(settingsBoundaries(root, file('agent-settings/store.ts'), file('index.ts'))).toHaveLength(
    1,
  )
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
