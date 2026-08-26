#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sourceRef = 'refs/heads/refactor/plugin-ledger-ownership'
const commits = [
  '7ee7de273d21bb56b5b541f88085f54634bde92e',
  '92dbf44f2fd03e4d4e73f9383fda96b401cf0c92',
]

function runGit(args, accepted = [0]) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const status = result.status ?? -1

  if (!accepted.includes(status)) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`git ${args.join(' ')} failed (${status})${detail ? `:\n${detail}` : ''}`)
  }

  return result
}

async function optionalText(path) {
  try {
    return await readFile(resolve(root, path), 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function state() {
  const [ledger, commands, host, manifest] = await Promise.all([
    optionalText('crates/plugin-host/src/ledger.rs'),
    optionalText('apps/desktop/src-tauri/src/commands/plugins.rs'),
    optionalText('crates/plugin-host/src/lib.rs'),
    optionalText('crates/plugin-host/Cargo.toml'),
  ])

  if (commands === null || host === null || manifest === null) {
    throw new Error('Refactor anchors are missing: expected plugin host and desktop command files')
  }

  const complete =
    ledger?.includes('pub struct PluginLedger') === true &&
    host.includes('mod ledger;') &&
    host.includes('PluginInstallation, PluginLedger, PluginRecord') &&
    manifest.includes('serde_json.workspace = true') &&
    commands.includes('host::PluginLedger::read') &&
    !commands.includes('fn read_record(') &&
    !commands.includes('fn entries_mut(')

  const untouched =
    ledger === null &&
    !host.includes('mod ledger;') &&
    !manifest.includes('serde_json.workspace = true') &&
    commands.includes('fn read_record(') &&
    commands.includes('fn entries_mut(') &&
    commands.includes('fn disabled_servers(')

  return { complete, untouched }
}

const [packageText, constitution] = await Promise.all([
  readFile(resolve(root, 'package.json'), 'utf8'),
  readFile(resolve(root, 'AGENTS.md'), 'utf8'),
])
const packageJson = JSON.parse(packageText)

if (packageJson.name !== 'poietica' || !constitution.includes('Poietica 架构宪法')) {
  throw new Error('Run refactor.mjs from the poietica repository root')
}

const initial = await state()
if (initial.complete) {
  console.log('plugin ledger refactor already applied; nothing to do')
  process.exit(0)
}
if (!initial.untouched) {
  throw new Error('Refactor anchors do not match: repository is partially changed or has drifted')
}

const dirty = runGit(['status', '--porcelain']).stdout
  .split(/\r?\n/u)
  .filter(Boolean)
  .filter((line) => line !== '?? refactor.mjs')
if (dirty.length > 0) {
  throw new Error(`Refactor requires a clean worktree; found:\n${dirty.join('\n')}`)
}

const originalHead = runGit(['rev-parse', 'HEAD']).stdout.trim()
const missingObject = commits.some(
  (commit) => runGit(['cat-file', '-e', `${commit}^{commit}`], [0, 1, 128]).status !== 0,
)
if (missingObject) {
  runGit(['fetch', 'origin', sourceRef])
}

for (const commit of commits) {
  const present = runGit(['merge-base', '--is-ancestor', commit, 'HEAD'], [0, 1]).status === 0
  if (present) {
    continue
  }

  const applied = runGit(['cherry-pick', commit], [0, 1])
  if (applied.status !== 0) {
    runGit(['cherry-pick', '--abort'], [0, 128])
    const detail = [applied.stdout, applied.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `Refactor anchors no longer apply cleanly at ${commit}; cherry-pick was aborted${
        detail ? `:\n${detail}` : ''
      }`,
    )
  }
}

const final = await state()
if (!final.complete) {
  runGit(['reset', '--hard', originalHead])
  throw new Error('Refactor postcondition failed; applied commits were rolled back')
}

console.log('plugin ledger refactor applied successfully')
