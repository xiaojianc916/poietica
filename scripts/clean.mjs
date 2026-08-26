#!/usr/bin/env bun
/**
 * Removes build output, caches and installed dependencies.
 *
 * 删除带重试：Windows 上刚退出的进程仍会短暂持有文件，fs.rm 的 maxRetries 与
 * retryDelay 正是为此而设（force 只忽略"不存在"）。失败逐个隔离汇报，不把人停
 * 在"依赖已经没了、产物还在"的半坏状态里。--all 连 target 一起删。
 */

import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/* 两档范围。差别只有 target：Rust 构建产物重建慢，只在 --all 时删。 */
const SCOPES = {
  all: new Set(['.turbo', 'dist', 'node_modules', 'target']),
  deps: new Set(['.turbo', 'dist', 'node_modules']),
}

const NEVER_ENTER = new Set(['.git'])

const DRY_RUN = process.argv.includes('--dry-run')

function chosenScope() {
  if (process.argv.includes('--all')) {
    return 'all'
  }
  return 'deps'
}

const scopeName = chosenScope()
const scope = SCOPES[scopeName]

const rel = (target) => path.relative(process.cwd(), target).split(path.sep).join('/')

/*
 * node_modules 最后删。它是唯一一个删掉之后就不能再跑任何 node 工具的目录，所以
 * 任何一个可能失败的删除都应该发生在它之前。
 */
function weight(target) {
  return path.basename(target) === 'node_modules' ? 1 : 0
}

async function collect(directory, found) {
  let entries

  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || NEVER_ENTER.has(entry.name)) {
      continue
    }

    const target = path.join(directory, entry.name)

    if (entry.name === 'node_modules') {
      /*
       * 从不深入 node_modules：它要么整个走，要么只交出 .vite。往里递归会为了
       * 几个缓存目录走完成千上万个包。
       */
      if (scope.has('node_modules')) {
        found.push(target)
      } else {
        const viteCache = path.join(target, '.vite')

        if (existsSync(viteCache)) {
          found.push(viteCache)
        }
      }

      continue
    }

    if (scope.has(entry.name)) {
      found.push(target)
      continue
    }

    await collect(target, found)
  }

  return found
}

const targets = (await collect(process.cwd(), [])).sort((a, b) => weight(a) - weight(b))

if (DRY_RUN) {
  for (const target of targets) {
    console.log(`Would remove ${rel(target)}`)
  }

  console.log(`\n${targets.length} directories in scope "${scopeName}".`)
  process.exit(0)
}

const failures = []
let removed = 0

for (const target of targets) {
  try {
    await rm(target, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
    removed += 1
  } catch (error) {
    failures.push({ path: rel(target), reason: error.code ?? String(error) })
  }
}

console.log(`Removed ${removed} directories (scope: ${scopeName}).`)

if (failures.length > 0) {
  console.error(`\n${failures.length} could not be removed:`)

  for (const failure of failures) {
    console.error(`  ${failure.path} — ${failure.reason}`)
  }

  console.error(
    '\nEPERM/EBUSY on Windows means something still holds the file: a running app, ' +
      'a dev server, or rust-analyzer. Close it and run again.',
  )

  process.exitCode = 1
}

if (scope.has('node_modules') && failures.length === 0) {
  console.log('\nDependencies are gone — run "bun install" before anything else.')
}
