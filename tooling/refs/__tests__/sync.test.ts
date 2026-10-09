import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { computeReferences, listProjects, planSync } from '../sync'

let root = ''
const put = (rel: string, content: string) => {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}
const pkg = (name: string, exports: Record<string, string>) => JSON.stringify({ name, exports })
const ts = (include: string[]) =>
  `${JSON.stringify({ extends: '../../tooling/tsconfig/neutral.json', include, references: [] }, null, 2)}\n`

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

function fixture(): void {
  root = mkdtempSync(path.join(tmpdir(), 'refs-'))
  put('tsconfig.json', '{"files":[],"references":[]}\n')
  put('tooling/tsconfig.json', ts(['scaffold']))
  put('tooling/scaffold/a.ts', 'export {}')
  put('packages/foundation/package.json', pkg('@poietica/foundation', { '.': './src/index.ts' }))
  put('packages/foundation/tsconfig.json', ts(['src']))
  put('packages/foundation/src/index.ts', 'export const x = 1')
  put(
    'packages/core-kernel/package.json',
    pkg('@poietica/core-kernel', { '.': './src/index.ts', './events': './src/events-def.ts' }),
  )
  put('packages/core-kernel/tsconfig.json', ts(['src']))
  put('packages/core-kernel/src/index.ts', "import { x } from '@poietica/foundation'\nexport { x }")
  put('packages/core-kernel/src/events-def.ts', 'export {}')
  put('packages/core-kernel/src/__tests__/k.test.ts', "import '@poietica/feature-demo/contract'")
  put(
    'features/demo/package.json',
    pkg('@poietica/feature-demo', { './contract': './src/contract/index.ts', './core-api': './src/core-api/index.ts' }),
  )
  put('features/demo/src/contract/tsconfig.json', ts(['.']))
  put('features/demo/src/contract/index.ts', "import type { x } from '@poietica/foundation'\nexport type Y = typeof x")
  put('features/demo/src/core-api/tsconfig.json', ts(['.']))
  put(
    'features/demo/src/core-api/index.ts',
    "import type { Y } from '../contract'\nimport '@poietica/core-kernel/events'\nimport 'zod'\nexport type Z = Y",
  )
}

test('listProjects 找到全部项目', () => {
  fixture()
  expect(listProjects(root)).toEqual([
    'features/demo/src/contract',
    'features/demo/src/core-api',
    'packages/core-kernel',
    'packages/foundation',
    'tooling',
  ])
})

test('computeReferences：包、子入口、相对路径；忽略测试与第三方', () => {
  fixture()
  const refs = computeReferences(root)
  expect(refs.get('packages/core-kernel')).toEqual(['../foundation'])
  expect(refs.get('features/demo/src/contract')).toEqual(['../../../../packages/foundation'])
  expect(refs.get('features/demo/src/core-api')).toEqual(['../../../../packages/core-kernel', '../contract'])
  expect(refs.get('packages/foundation')).toEqual([])
})

test('planSync：写入后再次计划为空', () => {
  fixture()
  const first = planSync(root)
  expect(first.has('tsconfig.json')).toBe(true)
  for (const [file, content] of first) writeFileSync(path.join(root, file), content)
  expect(planSync(root).size).toBe(0)
})
test('planSync 写出的 tsconfig 是合法 JSON，格式与 biome 一致', () => {
  fixture()
  const first = planSync(root)
  for (const [, content] of first) JSON.parse(content)
  expect(first.get('packages/core-kernel/tsconfig.json')).toContain(
    '"references": [\n    {\n      "path": "../foundation"\n    }\n  ]',
  )
  expect(first.get('tsconfig.json')).toContain(
    '"references": [\n    {\n      "path": "features/demo/src/contract"\n    },',
  )
})
