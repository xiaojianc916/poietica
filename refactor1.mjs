#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const TARGET = resolve(ROOT, 'refactor.mjs')
const MANIFEST = resolve(ROOT, 'package.json')

function fail(message) {
  throw new Error(message)
}

function countOccurrences(content, needle) {
  return content.split(needle).length - 1
}

function applyEdit(content, { name, before, after }) {
  const beforeCount = countOccurrences(content, before)
  const afterCount = countOccurrences(content, after)

  if (beforeCount === 0 && afterCount === 1) {
    return content
  }
  if (beforeCount !== 1 || afterCount !== 0) {
    fail(
      `${name}: expected one old anchor or one applied anchor; ` +
        `found old=${beforeCount}, applied=${afterCount}`,
    )
  }

  return content.replace(before, after)
}

async function atomicWrite(path, content, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { encoding: 'utf8', mode })

  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

const IPC_REPAIR_BEFORE = [
  '  await replaceOnce(',
  "    'packages/ipc/src/agent.ts',",
  '    `          threadId: null,\\n          configId: control.id,\\n          value,\\n        }),`,',
  '    `          threadId: null,\\n          configId: control.id,\\n          value,\\n          input: input ?? null,\\n        }),`,',
  '  )',
].join('\n')

const IPC_REPAIR_AFTER = [
  '  await replaceOnce(',
  "    'packages/ipc/src/agent.ts',",
  '    `          threadId,\\n          configId,\\n          value,\\n        }),`,',
  '    `          threadId,\\n          configId,\\n          value,\\n          input: input ?? null,\\n        }),`,',
  '  )',
  '  await replaceOnce(',
  "    'packages/ipc/src/agent.ts',",
  '    `          threadId: null,\\n          configId: control.id,\\n          value,\\n        }),`,',
  '    `          threadId: null,\\n          configId: control.id,\\n          value,\\n          input: null,\\n        }),`,',
  '  )',
].join('\n')

const EDITS = [
  {
    name: 'remove unused fs import',
    before: '  rm,\n  stat,\n  writeFile,',
    after: '  rm,\n  writeFile,',
  },
  {
    name: 'remove unused path import',
    before: "import { dirname, extname, relative, resolve } from 'node:path'",
    after: "import { dirname, extname, resolve } from 'node:path'",
  },
  {
    name: 'quote generated Skill row id',
    before: '          \\skill:\\${skill.name}\\,',
    after: '          \\`skill:\\${skill.name}\\`,',
  },
  {
    name: 'quote generated MCP row id',
    before: '          \\mcp:\\${server.id}\\,',
    after: '          \\`mcp:\\${server.id}\\`,',
  },
  {
    name: 'quote generated goal label',
    before: "  if (control.id === 'goal' && control.detail) return \\目标：\\${control.detail}\\",
    after: "  if (control.id === 'goal' && control.detail) return \\`目标：\\${control.detail}\\`",
  },
  {
    name: 'quote generated swarm label',
    before: '    return \\蜂群 · \\${String(swarm)}\\',
    after: '    return \\`蜂群 · \\${String(swarm)}\\`',
  },
  {
    name: 'quote generated mode-chip label',
    before: '            aria-label={\\退出\\${text}\\}',
    after: '            aria-label={\\`退出 \\${text}\\`}',
  },
  {
    name: 'route config input through the correct IPC bridge',
    before: IPC_REPAIR_BEFORE,
    after: IPC_REPAIR_AFTER,
  },
]

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  if (manifest.name !== 'poietica') {
    fail('run this script from the poietica repository root')
  }

  const original = await readFile(TARGET, 'utf8')
  const metadata = await stat(TARGET)
  const applied = []
  let repaired = original

  for (const edit of EDITS) {
    const next = applyEdit(repaired, edit)
    if (next !== repaired) {
      applied.push(edit.name)
    }
    repaired = next
  }

  const changed = repaired !== original
  if (changed) {
    await atomicWrite(TARGET, repaired, metadata.mode & 0o777)
  }

  const checked = spawnSync(process.execPath, ['--check', TARGET], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  })

  if (checked.error || checked.status !== 0) {
    if (changed) {
      await atomicWrite(TARGET, original, metadata.mode & 0o777)
    }
    const diagnostic = checked.error?.message ?? checked.stderr?.trim() ?? 'unknown syntax error'
    fail(`refactor.mjs failed node --check and was restored: ${diagnostic}`)
  }

  if (applied.length === 0) {
    console.log('refactor.mjs is already repaired and passes node --check.')
    return
  }

  console.log(`Repaired refactor.mjs (${String(applied.length)} deterministic edits).`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
}
