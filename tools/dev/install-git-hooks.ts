#!/usr/bin/env bun
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const GIT = { cwd: root, windowsHide: true } as const

async function main(): Promise<void> {
  if (process.env['CI']) {
    return
  }

  if (!existsSync(path.join(root, '.githooks', 'pre-commit'))) {
    return
  }

  /* 不是 git 仓库（例如从压缩包安装）时安静退出。 */
  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], GIT)
  } catch {
    return
  }

  await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], GIT)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
