#!/usr/bin/env bun
/**
 * 把发布版本一次写进四个声明处。Cargo workspace 仍是唯一真相，其余三处由它派生。
 *
 * 四个文件走同一条管线：定位那一个 version 键，逐字节替换它的值，别的一个字不动。
 *
 *   bun run version:set 0.2.0
 */

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { SEMVER } from './version.ts'

const version = process.argv[2]

if (!SEMVER.test(version ?? '')) {
  console.error('用法：bun run version:set <语义化版本>，例如：bun run version:set 0.2.0')
  process.exit(2)
}

/*
 * 顶层那一个 version 键：TOML 的在 [workspace.package] 段内，JSON 的在两格缩进的
 * 第一层 —— 靠缩进锚定，依赖里同名的 version 字段不会被误伤。
 */
const TARGETS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Cargo.toml', /(^\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+(")/m],
  ['package.json', /(^ {2}"version":\s*")[^"]+(")/m],
  ['apps/desktop/package.json', /(^ {2}"version":\s*")[^"]+(")/m],
  ['apps/desktop/src-tauri/tauri.conf.json', /(^ {2}"version":\s*")[^"]+(")/m],
]

for (const [file, pattern] of TARGETS) {
  const source = await readFile(file, 'utf8')

  if (!pattern.test(source)) {
    console.error(`${file}：找不到 version 键`)
    process.exit(2)
  }

  await writeFile(file, source.replace(pattern, `$1${version}$2`), 'utf8')
}

console.log(`已写入版本 ${version}（${TARGETS.length} 个文件），再跑 bun run check:versions 确认`)
