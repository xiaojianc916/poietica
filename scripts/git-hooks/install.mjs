#!/usr/bin/env bun

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = process.cwd()

async function main() {
  if (process.env.CI) {
    return
  }

  if (!existsSync(path.join(root, '.githooks', 'pre-commit'))) {
    return
  }

  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      windowsHide: true,
    })
  } catch {
    return
  }

  await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: root,
    windowsHide: true,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
