#!/usr/bin/env bun
/**
 * 版本的单一真相是 Cargo workspace。传入 tag 时，tag 也算一处声明。
 *
 * 少了 tag 这一条，v0.1.2 的 tag 可以发出一个内部版本号还是 0.1.1 的安装包：
 * 客户端装完之后仍然认为 latest.json 比自己新，于是无限提示更新。
 *
 *   node scripts/release/check-versions.mjs [tag]
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'

const sources = [
  [
    'Cargo.toml [workspace.package]',
    'Cargo.toml',
    (text) => text.split(/^\[workspace\.package\]$/m)[1]?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  ],
  ['package.json', 'package.json', (text) => JSON.parse(text).version],
  ['apps/desktop/package.json', 'apps/desktop/package.json', (text) => JSON.parse(text).version],
  ['tauri.conf.json', 'apps/desktop/src-tauri/tauri.conf.json', (text) => JSON.parse(text).version],
]

const declared = await Promise.all(
  sources.map(async ([label, file, read]) => [label, read(await readFile(file, 'utf8'))]),
)

const expected = declared[0][1]

if (!expected) {
  console.error('Could not read [workspace.package] version from Cargo.toml')
  process.exit(2)
}

const tag = process.argv[2]

if (tag) {
  declared.push([`tag ${tag}`, tag.replace(/^v/, '')])
}

let consistent = true

for (const [label, version] of declared) {
  const matches = version === expected
  consistent = consistent && matches
  console.log(`${matches ? 'ok   ' : 'DRIFT'} ${label}: ${version}`)
}

if (!consistent) {
  console.error(`\nRelease version must be ${expected} everywhere.`)
  process.exit(1)
}
