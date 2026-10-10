#!/usr/bin/env bun
/**
 * 三处版本号声明必须处处相同（15 页 §10.1）。唯一来源是 apps/desktop 的 version，
 * apps/core 由它派生 —— 一个安装包里两半版本不一致，只会意味着装坏了。
 *
 * 用法：
 *   bun run  all:versions          只检查
 *   bun run  all:versions v0.5.0   连带核对 tag（发布链在打标前调用）
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { SEMVER, VERSION_FILES, VERSION_SOURCE } from './version'

const declared: Array<readonly [string, string | undefined]> = await Promise.all(
  VERSION_FILES.map(async (file): Promise<readonly [string, string | undefined]> => {
    const raw = await readFile(file, 'utf8').catch(() => undefined)
    if (raw === undefined) {
      return [file, undefined]
    }
    const parsed = JSON.parse(raw) as { version?: unknown }
    const version = typeof parsed.version === 'string' ? parsed.version : undefined
    return [file, version]
  }),
)

const source = VERSION_FILES.indexOf(VERSION_SOURCE)
const expected = declared[source]?.[1]
if (expected === undefined || !SEMVER.test(expected)) {
  console.error(`${VERSION_SOURCE} 里没有合法的语义化版本号`)
  process.exit(2)
}

const tag = process.argv[2]
if (tag !== undefined) {
  /* tag 的 `v` 前缀由发布链统一加；这里只比对版本部分，打错版本在打标前就现形。 */
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
