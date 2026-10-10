#!/usr/bin/env bun
/**
 * 把发布版本一次写进声明处。唯一来源是 `apps/desktop/package.json`（15 页 §10.1），
 * `apps/core/package.json` 由它派生：Host 与 Core 总是一起发布，两半版本不一致
 * 只会意味着装坏了。
 *
 * 每个文件走同一条管线：定位那一个顶层 version 键，逐字节替换它的值，别的一个字不动 ——
 * 整份重序列化会把仓库里的排版（空行、字段次序）搅乱，而这些文件是人工维护的。
 *
 *   bun run version:set 0.5.1
 */

import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { LOCK_COMMANDS, LOCK_FILES, SEMVER, VERSION_FILES } from './version'

const version = process.argv[2]

if (!SEMVER.test(version ?? '')) {
  console.error('用法：bun run version:set <语义化版本>，例如：bun run version:set 0.5.1')
  process.exit(2)
}

/*
 * 顶层那一个 version 键：JSON 的第一层，靠两格缩进锚定 ——
 * 依赖里同名的 version 字段（以及嵌套对象）不会被误伤。
 */
const PATTERN: Record<(typeof VERSION_FILES)[number], RegExp> = {
  'apps/desktop/package.json': /(^ {2}"version":\s*")[^"]+(")/m,
  'apps/core/package.json': /(^ {2}"version":\s*")[^"]+(")/m,
}

for (const file of VERSION_FILES) {
  const source = await readFile(file, 'utf8')

  if (!PATTERN[file].test(source)) {
    console.error(`${file}：找不到 version 键`)
    process.exit(2)
  }

  await writeFile(file, source.replace(PATTERN[file], `$1${version}$2`), 'utf8')
}

/*
 * 锁文件跟着重算。它不是第三处手写声明，而是包管理器自己的产物：
 * 跳过这一步，发布提交里就会留下一个旧版本的 bun.lock —— 那正是 legacy v0.4.3
 * 发布后工作区里那个改不完的文件。命令失败即停：一个没跟上的锁文件不该被静悄悄放过。
 */
for (const file of LOCK_FILES) {
  const [program, ...args] = LOCK_COMMANDS[file]
  if (spawnSync(program, args, { stdio: 'inherit' }).status !== 0) {
    console.error(`${file} 没能跟上 ${version}：先手动跑 ${[program, ...args].join(' ')}`)
    process.exit(2)
  }
}

console.log(
  `已写入版本 ${version}（${String(VERSION_FILES.length)} 个声明处 + ${String(LOCK_FILES.length)} 个锁文件），再跑 bun run  all:versions 确认`,
)
