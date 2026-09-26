#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { SEMVER, VERSION_FILES, workspaceVersion } from './version.ts'

const versionOf = (text: string): string | undefined =>
  (JSON.parse(text) as { version?: string }).version

const READERS: Record<(typeof VERSION_FILES)[number], (text: string) => string | undefined> = {
  'Cargo.toml': workspaceVersion,
  'package.json': versionOf,
  'apps/desktop/package.json': versionOf,
  'apps/desktop/src-tauri/tauri.conf.json': versionOf,
}

const declared: Array<readonly [string, string | undefined]> = await Promise.all(
  VERSION_FILES.map(
    async (file): Promise<readonly [string, string | undefined]> => [
      file,
      READERS[file](await readFile(file, 'utf8')),
    ],
  ),
)

const expected = declared[0]?.[1]
if (expected === undefined || !SEMVER.test(expected)) {
  console.error('Cargo.toml [workspace.package] 里没有合法的语义化版本号')
  process.exit(2)
}

const tag = process.argv[2]
if (tag !== undefined) {
  declared.push([`tag ${tag}`, tag.replace(/^v/, '')])
}

let consistent = true
for (const [label, version] of declared) {
  const matches = version === expected
  consistent = consistent && matches
  console.log(`${matches ? '通过  ' : '不一致'} ${label}：${version ?? '（缺失）'}`)
}

if (!consistent) {
  console.error(`\n发布版本必须处处都是 ${expected}。`)
  process.exit(1)
}
