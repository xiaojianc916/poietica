#!/usr/bin/env bun
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/* 两档范围，差别只有 target：Rust 构建产物重建慢，只在 --all 时删。 */
const ALWAYS = ['.turbo', 'dist', 'node_modules']

const NEVER_ENTER = new Set(['.git'])

/* maxRetries/retryDelay 是为 Windows 上刚退出的进程仍持有文件而设。 */
const REMOVE = { force: true, maxRetries: 10, recursive: true, retryDelay: 100 } as const

type Failure = { path: string; reason: string }

const all = process.argv.includes('--all')
const scope = new Set(all ? [...ALWAYS, 'target'] : ALWAYS)
const scopeName = all ? 'all' : 'deps'

const rel = (target: string): string =>
  path.relative(process.cwd(), target).split(path.sep).join('/')

/* node_modules 最后删：删完它就没有任何 node 工具可跑了。 */
const weight = (target: string): number => (path.basename(target) === 'node_modules' ? 1 : 0)

const codeOf = (value: unknown): string | undefined => {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code?: unknown }).code

    if (typeof code === 'string') {
      return code
    }
  }

  return undefined
}

async function collect(directory: string, found: string[]): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)

  if (entries === undefined) {
    return found
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || NEVER_ENTER.has(entry.name)) {
      continue
    }

    const target = path.join(directory, entry.name)

    if (scope.has(entry.name)) {
      found.push(target)
      continue
    }

    await collect(target, found)
  }

  return found
}

async function main(): Promise<void> {
  const targets = (await collect(process.cwd(), [])).sort((a, b) => weight(a) - weight(b))

  if (process.argv.includes('--dry-run')) {
    for (const target of targets) {
      console.log('Would remove', rel(target))
    }

    console.log(targets.length, 'directories in scope', scopeName)

    return
  }

  const failures: Failure[] = []
  let removed = 0

  for (const target of targets) {
    try {
      await rm(target, REMOVE)
      removed += 1
    } catch (error) {
      failures.push({ path: rel(target), reason: codeOf(error) ?? String(error) })
    }
  }

  console.log('Removed', removed, 'directories in scope', scopeName)

  /* 失败逐个隔离汇报，不把人留在「依赖没了、产物还在」的半坏状态里。 */
  if (failures.length > 0) {
    console.error(failures.length, 'could not be removed:')

    for (const failure of failures) {
      console.error(' ', failure.path, '-', failure.reason)
    }

    console.error(
      'EPERM/EBUSY on Windows means something still holds the file: a running app,',
      'a dev server, or rust-analyzer. Close it and run again.',
    )

    process.exitCode = 1

    return
  }

  console.log('Dependencies are gone - run "bun install" before anything else.')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
