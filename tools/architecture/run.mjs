#!/usr/bin/env bun
/* biome-ignore-all lint/suspicious/noConsole: this CLI reports architecture violations. */

/**
 * Architecture checker.
 *
 * One filesystem walk, one read per file, every rule from rules.config.mjs,
 * every violation reported as file:line:column. Never short-circuits.
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  ignoredDirectories,
  inventoryRoots,
  rules,
  sourceExtensions,
  sourceRoots,
  toPosixPath,
} from './rules.config.mjs'

const checkDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(checkDirectory, '../..')

/* 所有规则共享一次文件系统遍历，确保忽略策略与汇总语义一致。 */
async function collectInventory() {
  const directories = []
  const files = []

  for (const root of inventoryRoots) {
    let entries

    try {
      entries = await readdir(path.join(repositoryRoot, root), {
        withFileTypes: true,
        recursive: true,
      })
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue
      }

      throw error
    }

    for (const entry of entries) {
      const absolute = path.join(entry.parentPath, entry.name)
      const entryPath = toPosixPath(path.relative(repositoryRoot, absolute))

      if (entryPath.split('/').some((segment) => ignoredDirectories.has(segment))) {
        continue
      }

      if (entry.isDirectory()) {
        directories.push(entryPath)
      } else if (entry.isFile()) {
        files.push(entryPath)
      }
    }
  }

  return { directories: directories.sort(), files: files.sort() }
}

function positionOf(source, index) {
  const preceding = source.slice(0, index)
  const lineBreak = preceding.lastIndexOf('\n')

  return { line: preceding.split('\n').length, column: index - lineBreak }
}

const inventory = await collectInventory()

const contents = new Map()

/* 同一个文件只读一次，pattern 规则与 check 规则共用这份缓存。 */
const read = async (file) => {
  if (!contents.has(file)) {
    contents.set(file, await readFile(path.join(repositoryRoot, file), 'utf8'))
  }

  return contents.get(file)
}

const isPatternTarget = (file) =>
  sourceExtensions.has(path.extname(file)) &&
  sourceRoots.some((root) => file.startsWith(`${root}/`))

const violations = []

for (const file of inventory.files.filter(isPatternTarget)) {
  const applicable = rules.filter((rule) => rule.pattern !== undefined && rule.appliesTo(file))

  if (applicable.length === 0) {
    continue
  }

  const source = await read(file)

  for (const rule of applicable) {
    for (const match of source.matchAll(rule.pattern)) {
      const position = positionOf(source, match.index)
      const hint = rule.hint === undefined ? null : rule.hint(match[0])

      violations.push({
        file,
        line: position.line,
        column: position.column,
        rule: rule.id,
        message: hint === null ? rule.message : `${rule.message} (use ${hint})`,
      })
    }
  }
}

/* 非源码位置的结构缺陷统一定位到 1:1。 */
for (const rule of rules) {
  if (rule.check === undefined) {
    continue
  }

  for (const defect of await rule.check({ ...inventory, read })) {
    violations.push({
      file: defect.file,
      line: defect.line ?? 1,
      column: defect.column ?? 1,
      rule: rule.id,
      message: defect.message,
    })
  }
}

/* Architecture invariants have one executable owner. */
for (const entry of await readdir(checkDirectory)) {
  if (!entry.startsWith('check-') || !entry.endsWith('.mjs')) {
    continue
  }

  violations.push({
    file: `tools/architecture/${entry}`,
    line: 1,
    column: 1,
    rule: 'no-task-scoped-guards',
    message: 'architecture rules belong in rules.config.mjs, not in a standalone script',
  })
}

/* pattern 与 check 两路汇进来，顺序按文件位置定，输出才是确定的。 */
violations.sort(
  (left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column,
)

if (violations.length === 0) {
  console.log('Architecture rules passed.')
} else {
  console.error('')
  console.error(`Architecture violations (${violations.length}):`)
  console.error('')

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}:${violation.column}  ${violation.rule}`)
    console.error(`  ${violation.message}`)
  }

  console.error('')
  process.exitCode = 1
}
