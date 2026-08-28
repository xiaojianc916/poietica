#!/usr/bin/env bun
/**
 * 版本的单一真相是 Cargo workspace。传入 tag 时，tag 也算一处声明。
 *
 * 少了 tag 这一条，v0.1.2 的 tag 可以发出一个内部版本号还是 0.1.1 的安装包：
 * 客户端装完之后仍然认为 latest.json 比自己新，于是无限提示更新。
 *
 *   bun tools/release/check-versions.ts [tag]
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { workspaceVersion } from './version.ts'

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

if (expected === undefined) {
  console.error('Could not read [workspace.package] version from Cargo.toml')
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
