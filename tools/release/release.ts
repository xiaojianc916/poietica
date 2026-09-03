#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { bumped, compareVersions, SEMVER, workspaceVersion } from './version.ts'

const MAIN_BRANCH = 'main'
const VERSION_FILES = [
  'Cargo.toml',
  'package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
] as const

class ReleaseError extends Error {}

let baseSha = ''
let versionTouched = false
let commitCreated = false
let tagCreated = false
let pushed = false
let releaseTag = ''
let terminal: ReturnType<typeof createInterface> | undefined

function line(argv: readonly string[]): string {
  return argv.map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(' ')
}

function run(...argv: string[]): void {
  const [program, ...args] = argv
  if (!program) {
    throw new ReleaseError('empty command')
  }
  console.log(`$ ${line(argv)}`)
  const result = spawnSync(program, args, { stdio: 'inherit' })
  if (result.error) {
    throw new ReleaseError(`${program}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new ReleaseError(`command exited with ${result.status ?? 'no status'}: ${line(argv)}`)
  }
}

function output(...argv: string[]): string {
  const [program, ...args] = argv
  if (!program) {
    throw new ReleaseError('empty command')
  }
  const result = spawnSync(program, args, { encoding: 'utf8' })
  if (result.error) {
    throw new ReleaseError(`${program}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim()
    throw new ReleaseError([`command failed: ${line(argv)}`, detail].filter(Boolean).join('\n'))
  }
  return result.stdout.trim()
}

function tryOutput(...argv: string[]): string | null {
  const [program, ...args] = argv
  if (!program) {
    return null
  }
  const result = spawnSync(program, args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function tryRun(...argv: string[]): void {
  const [program, ...args] = argv
  if (!program) {
    return
  }
  const result = spawnSync(program, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`rollback command failed: ${line(argv)}`)
  }
}

function clean(): boolean {
  return output('git', 'status', '--porcelain=v1', '--untracked-files=all') === ''
}

function rollback(): void {
  if (pushed || !baseSha) {
    return
  }
  if (tagCreated && releaseTag) {
    tryRun('git', 'tag', '--delete', releaseTag)
  }
  if (commitCreated) {
    tryRun('git', 'reset', '--mixed', baseSha)
  }
  if (versionTouched) {
    tryRun('git', 'restore', '--source', baseSha, '--staged', '--worktree', '--', ...VERSION_FILES)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    rollback()
    console.error(`\n${signal}: release cancelled`)
    process.exit(130)
  })
}

function reader(): ReturnType<typeof createInterface> {
  terminal ??= createInterface({ input: process.stdin, output: process.stdout })
  return terminal
}

async function targetVersion(current: string, requested: string | undefined, yes: boolean) {
  const next = bumped(current)
  const input =
    requested ??
    (yes
      ? 'patch'
      : (
          await reader().question(
            `Version [patch ${next.patch}; minor ${next.minor}; major ${next.major}] (patch): `,
          )
        ).trim() || 'patch')
  const presets = new Map([
    ['patch', next.patch],
    ['minor', next.minor],
    ['major', next.major],
  ])
  const target = presets.get(input) ?? input
  if (!SEMVER.test(target)) {
    throw new ReleaseError(`invalid semantic version: ${target}`)
  }
  if (compareVersions(target, current) <= 0) {
    throw new ReleaseError(`target ${target} must be newer than ${current}`)
  }
  return target
}

async function confirm(tag: string, yes: boolean): Promise<void> {
  if (yes) {
    return
  }
  const answer = (await reader().question(`Publish ${tag} from main? [y/N] `)).trim().toLowerCase()
  if (answer !== 'y' && answer !== 'yes') {
    throw new ReleaseError('release cancelled')
  }
}

async function findWorkflowRun(sha: string): Promise<string> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const id = tryOutput(
      'gh',
      'run',
      'list',
      '--workflow',
      'release.yml',
      '--commit',
      sha,
      '--event',
      'push',
      '--limit',
      '1',
      '--json',
      'databaseId',
      '--jq',
      '.[0].databaseId // empty',
    )
    if (id) {
      return id
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new ReleaseError('release workflow did not appear within 90 seconds')
}

function printHelp(): void {
  console.log(
    [
      'Usage: bun release [patch|minor|major|VERSION] [--yes] [--no-wait]',
      '',
      'Creates one version commit and annotated tag, pushes both atomically,',
      'then waits for the signed GitHub Actions release by default.',
    ].join('\n'),
  )
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      yes: { type: 'boolean', short: 'y' },
      'no-wait': { type: 'boolean' },
    },
  })
  if (values.help) {
    printHelp()
    return
  }
  if (positionals.length > 1) {
    throw new ReleaseError('expected at most one version argument')
  }

  const rootPackage = JSON.parse(await readFile('package.json', 'utf8')) as { name?: string }
  if (rootPackage.name !== 'poietica') {
    throw new ReleaseError('run this command at the repository root')
  }
  output('git', '--version')
  output('bun', '--version')
  if (output('git', 'branch', '--show-current') !== MAIN_BRANCH) {
    throw new ReleaseError(`releases must start from ${MAIN_BRANCH}`)
  }
  if (!clean()) {
    throw new ReleaseError('the working tree must be clean')
  }

  console.log('Fetching origin and tags...')
  run('git', 'fetch', '--prune', '--tags', 'origin')
  baseSha = output('git', 'rev-parse', 'HEAD')
  const remoteSha = output('git', 'rev-parse', `refs/remotes/origin/${MAIN_BRANCH}`)
  if (baseSha !== remoteSha) {
    throw new ReleaseError(`local ${MAIN_BRANCH} must exactly match origin/${MAIN_BRANCH}`)
  }

  const current = workspaceVersion(await readFile('Cargo.toml', 'utf8'))
  if (!current || !SEMVER.test(current)) {
    throw new ReleaseError('Cargo.toml does not contain a valid workspace version')
  }
  const target = await targetVersion(current, positionals[0], values.yes === true)
  releaseTag = `v${target}`
  if (tryOutput('git', 'show-ref', '--verify', `refs/tags/${releaseTag}`) !== null) {
    throw new ReleaseError(`tag already exists: ${releaseTag}`)
  }
  if (!values['no-wait']) {
    run('gh', 'auth', 'status')
  }
  await confirm(releaseTag, values.yes === true)

  console.log('\nRunning the local quality gate...')
  run('bun', 'run', 'check')
  if (!clean()) {
    throw new ReleaseError('the quality gate changed the working tree')
  }

  versionTouched = true
  run('bun', 'run', 'version:set', target)
  run('bun', 'run', 'check:versions', releaseTag)
  run('git', 'diff', '--check')

  const changed = output('git', 'diff', '--name-only', '--').split(/\r?\n/).filter(Boolean)
  const unexpected = changed.filter(
    (file) => !VERSION_FILES.includes(file as (typeof VERSION_FILES)[number]),
  )
  if (changed.length !== VERSION_FILES.length || unexpected.length > 0) {
    throw new ReleaseError(`versioning changed unexpected files: ${changed.join(', ') || '(none)'}`)
  }

  run('git', 'add', '--', ...VERSION_FILES)
  run('git', 'commit', '--message', `release: ${releaseTag}`)
  commitCreated = true
  run('git', 'tag', '--annotate', releaseTag, '--message', `Poietica ${releaseTag}`)
  tagCreated = true

  const releaseSha = output('git', 'rev-parse', 'HEAD')
  run(
    'git',
    'push',
    '--atomic',
    'origin',
    `HEAD:refs/heads/${MAIN_BRANCH}`,
    `refs/tags/${releaseTag}:refs/tags/${releaseTag}`,
  )
  pushed = true

  if (values['no-wait']) {
    console.log(`${releaseTag} dispatched; GitHub Actions owns build, signing and publication.`)
    return
  }

  const runId = await findWorkflowRun(releaseSha)
  run('gh', 'run', 'watch', runId, '--exit-status')
  const url = output('gh', 'release', 'view', releaseTag, '--json', 'url', '--jq', '.url')
  console.log(`Published ${releaseTag}: ${url}`)
}

main()
  .catch((error: unknown) => {
    rollback()
    console.error(error instanceof Error ? error.message : String(error))
    if (pushed) {
      console.error('The remote commit and tag were kept; the CI run can be inspected or rerun.')
    }
    process.exitCode = 1
  })
  .finally(() => terminal?.close())
