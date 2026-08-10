#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const target = path.resolve(process.cwd(), 'refactor.mjs')

const before = [
  '        saveInFlight = false',
  '        persisted = submitted',
  '',
  '        if (!settingsEqual(draft, persisted)) {',
  "          publish('ready')",
].join('\n')

const after = [
  '        saveInFlight = false',
  '        persisted = submitted',
  '',
  '        const currentDraft = draft',
  '',
  '        if (currentDraft === null) {',
  '          return',
  '        }',
  '',
  '        if (!settingsEqual(currentDraft, submitted)) {',
  "          publish('ready')",
].join('\n')

function fail(message) {
  throw new Error(`fix-settings-refactor-save: ${message}`)
}

function occurrences(source, anchor) {
  return source.split(anchor).length - 1
}

function patch(source) {
  const oldCount = occurrences(source, before)

  const newCount = occurrences(source, after)

  if (oldCount === 0 && newCount === 1) {
    return source
  }

  if (oldCount === 1 && newCount === 0) {
    return source.replace(before, after)
  }

  fail(
    'expected exactly one old or one new ' +
      'save-completion anchor ' +
      `(old=${oldCount}, new=${newCount})`,
  )
}

function writeAtomically(content) {
  const token = `${process.pid}-` + randomBytes(6).toString('hex')

  const temporary = `${target}.fix-save-${token}.tmp`

  const backup = `${target}.fix-save-${token}.bak`

  const mode = statSync(target).mode & 0o777

  const descriptor = openSync(temporary, 'wx', mode)

  try {
    writeFileSync(descriptor, content, 'utf8')

    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }

  try {
    renameSync(target, backup)

    try {
      renameSync(temporary, target)
    } catch (cause) {
      renameSync(backup, target)

      throw cause
    }

    const checked = spawnSync(process.execPath, ['--check', target], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    if (checked.error || checked.status !== 0) {
      const diagnostic = `${checked.stdout ?? ''}` + `${checked.stderr ?? ''}`

      rmSync(target, {
        force: true,
      })

      renameSync(backup, target)

      if (checked.error) {
        throw checked.error
      }

      fail('patched refactor.mjs is invalid' + (diagnostic.trim() ? `:\n${diagnostic.trim()}` : ''))
    }

    unlinkSync(backup)
  } catch (cause) {
    if (existsSync(temporary)) {
      rmSync(temporary, {
        force: true,
      })
    }

    if (!existsSync(target) && existsSync(backup)) {
      renameSync(backup, target)
    }

    throw cause
  }
}

try {
  if (!existsSync(target) || !statSync(target).isFile()) {
    fail('run this script from the repository root containing refactor.mjs')
  }

  const original = readFileSync(target, 'utf8')

  const usesCrLf = original.includes('\r\n')

  const normalized = original.replaceAll('\r\n', '\n')

  const next = patch(normalized)

  if (next === normalized) {
    console.log('fix-settings-refactor-save: already applied; no files changed')
  } else {
    const output = usesCrLf ? next.replaceAll('\n', '\r\n') : next

    writeAtomically(output)

    console.log('fix-settings-refactor-save: repaired save completion narrowing')
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.stack : cause)

  process.exitCode = 1
}
