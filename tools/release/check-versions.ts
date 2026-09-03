#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { SEMVER, workspaceVersion } from './version.ts'

type Read = (text: string) => string | undefined

const versionOf: Read = (text) => (JSON.parse(text) as { version?: string }).version

const sources: ReadonlyArray<readonly [string, string, Read]> = [
  ['Cargo.toml [workspace.package]', 'Cargo.toml', workspaceVersion],
  ['package.json', 'package.json', versionOf],
  ['apps/desktop/package.json', 'apps/desktop/package.json', versionOf],
  ['tauri.conf.json', 'apps/desktop/src-tauri/tauri.conf.json', versionOf],
]

const declared: Array<readonly [string, string | undefined]> = await Promise.all(
  sources.map(
    async ([label, file, reader]): Promise<readonly [string, string | undefined]> => [
      label,
      reader(await readFile(file, 'utf8')),
    ],
  ),
)

const expected = declared[0]?.[1]
if (expected === undefined || !SEMVER.test(expected)) {
  console.error('Cargo.toml [workspace.package] does not contain a valid semantic version')
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
  console.log(`${matches ? 'ok   ' : 'DRIFT'} ${label}: ${version ?? '(missing)'}`)
}

if (!consistent) {
  console.error(`\nRelease version must be ${expected} everywhere.`)
  process.exit(1)
}
