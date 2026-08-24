#!/usr/bin/env bun
/**
 * 把发布版本一次写进四个声明处。
 *
 * check-versions.mjs 只在漂移之后报错 —— 检测有了，写入没有，于是每次发版都是
 * 手改四个文件再祈祷。这条命令补上另一半：Cargo workspace 仍是唯一真相，其余
 * 三处由它派生。
 *
 * 四个文件走同一条管线：定位那一个 version 键，逐字节替换它的值，别的一个字不动。
 * 上一版对 Cargo.toml 是这么做的，对三个 JSON 却走 JSON.parse + JSON.stringify，
 * 等于每次发版都按 stringify 的口味重排一遍文件 —— tauri.conf.json 里塞得进一行
 * 的短数组会被撑成多行，于是 release.mjs 不得不在后面补跑一次 biome format 擦屁
 * 股。一套文件两种写法，兜底就是这么长出来的。统一之后，那道兜底已被删除。
 *
 *   pnpm version:set 0.2.0
 */

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { SEMVER } from './version.mjs'

const version = process.argv[2]

if (!SEMVER.test(version ?? '')) {
  console.error('usage: pnpm version:set <semver>   e.g. pnpm version:set 0.2.0')
  process.exit(2)
}

/*
 * 顶层那一个 version 键：TOML 的在 [workspace.package] 段内，JSON 的在两格缩进的
 * 第一层 —— 靠缩进锚定，依赖里同名的 version 字段（tauri.conf.json 的 bundle、
 * package.json 的 dependencies）不会被误伤。
 */
const TARGETS = [
  ['Cargo.toml', /(^\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+(")/m],
  ['package.json', /(^ {2}"version":\s*")[^"]+(")/m],
  ['apps/desktop/package.json', /(^ {2}"version":\s*")[^"]+(")/m],
  ['apps/desktop/src-tauri/tauri.conf.json', /(^ {2}"version":\s*")[^"]+(")/m],
]

for (const [file, pattern] of TARGETS) {
  const source = await readFile(file, 'utf8')

  if (!pattern.test(source)) {
    console.error(`${file}: could not locate the version key`)
    process.exit(2)
  }

  await writeFile(file, source.replace(pattern, `$1${version}$2`), 'utf8')
}

console.log(
  `version set to ${version} in ${TARGETS.length} files; run pnpm check:versions to confirm`,
)
