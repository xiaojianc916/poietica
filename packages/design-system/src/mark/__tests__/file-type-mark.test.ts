import { expect, test } from 'bun:test'
import type { FileMarkId } from '../file-mark-assets'
import { fileMarkIdOf } from '../file-type-mark'

/* 表是本产品自己的知识：整名优先于后缀，路径规则优先于后缀，后缀先长后短。 */
const CASES: readonly (readonly [string, FileMarkId])[] = [
  ['version.ts', 'typescript'],
  ['index.tsx', 'react_ts'],
  ['docx.svg', 'svg'],
  ['layers.css', 'css'],
  ['electron-builder.yml', 'yaml'],
  ['biome.json', 'biome'],
  ['bunfig.toml', 'bun'],
  ['package.json', 'nodejs'],
  ['README.md', 'readme'],
  ['ARCHITECTURE.md', 'architecture'],
  ['LICENSE', 'license'],
  ['.gitignore', 'git'],
  ['tsconfig.tests.json', 'tsconfig'],
  ['.github/workflows/ci.yml', 'github-actions-workflow'],
  ['vite.config.ts', 'vite'],
  ['apps/desktop/electron.vite.config.ts', 'vite'],
  ['installer.nsh', 'command'],
  ['raw-errors.grit', 'command'],
  ['history-legacy.test.ts.snap', 'test-ts'],
  ['index.d.ts', 'typescript-def'],
]

for (const [name, expected] of CASES) {
  test(`${name} → ${expected}`, () => {
    expect(fileMarkIdOf(name)).toBe(expected)
  })
}
