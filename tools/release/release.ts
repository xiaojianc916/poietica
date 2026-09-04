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
    throw new ReleaseError('空命令')
  }
  console.log(`$ ${line(argv)}`)
  const result = spawnSync(program, args, { stdio: 'inherit' })
  if (result.error) {
    throw new ReleaseError(`${program}：${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new ReleaseError(`命令失败（退出码 ${result.status ?? '未知'}）：${line(argv)}`)
  }
}

function output(...argv: string[]): string {
  const [program, ...args] = argv
  if (!program) {
    throw new ReleaseError('空命令')
  }
  const result = spawnSync(program, args, { encoding: 'utf8' })
  if (result.error) {
    throw new ReleaseError(`${program}：${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim()
    throw new ReleaseError([`命令失败：${line(argv)}`, detail].filter(Boolean).join('\n'))
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
    console.error(`回滚命令失败：${line(argv)}`)
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
    console.error(
      pushed
        ? `\n${signal}：已停止本地等待；远端发布继续由 GitHub Actions 接管`
        : `\n${signal}：已取消发布`,
    )
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
            `发哪个版本？[patch ${next.patch}；minor ${next.minor}；major ${next.major}]（默认 patch）：`,
          )
        ).trim() || 'patch')
  const presets = new Map([
    ['patch', next.patch],
    ['minor', next.minor],
    ['major', next.major],
  ])
  const target = presets.get(input) ?? input
  if (!SEMVER.test(target)) {
    throw new ReleaseError(`版本号不合法：${target}`)
  }
  if (compareVersions(target, current) <= 0) {
    throw new ReleaseError(`目标版本 ${target} 必须比当前版本 ${current} 新`)
  }
  return target
}

async function confirm(tag: string, yes: boolean): Promise<void> {
  if (yes) {
    return
  }
  const answer = (await reader().question(`确认从 main 发布 ${tag}？[y/N] `)).trim().toLowerCase()
  if (answer !== 'y' && answer !== 'yes') {
    throw new ReleaseError('已取消发布')
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
  throw new ReleaseError('90 秒内没等到 release workflow 出现')
}

function printHelp(): void {
  console.log(
    [
      '用法：bun release [patch|minor|major|版本号] [--yes] [--no-wait]',
      '',
      '写一次版本号、打一个版本提交和附注 tag，原子推送到远端，',
      '默认继续等待 GitHub Actions 上的签名 release 完成。',
      '质量门禁（bun run check）、依赖审计、签名构建都在 CI 里跑，本地只做版本一致性检查。',
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
    throw new ReleaseError('最多只能指定一个版本参数')
  }

  const rootPackage = JSON.parse(await readFile('package.json', 'utf8')) as { name?: string }
  if (rootPackage.name !== 'poietica') {
    throw new ReleaseError('请在仓库根目录运行')
  }
  output('git', '--version')
  output('bun', '--version')
  if (output('git', 'branch', '--show-current') !== MAIN_BRANCH) {
    throw new ReleaseError(`发布必须从 ${MAIN_BRANCH} 分支出发`)
  }
  if (!clean()) {
    throw new ReleaseError('工作区必须干净：先提交或暂存改动')
  }

  console.log('正在同步 origin 与 tag……')
  run('git', 'fetch', '--prune', '--tags', 'origin')
  baseSha = output('git', 'rev-parse', 'HEAD')
  const remoteSha = output('git', 'rev-parse', `refs/remotes/origin/${MAIN_BRANCH}`)
  if (baseSha !== remoteSha) {
    throw new ReleaseError(`本地 ${MAIN_BRANCH} 必须与 origin/${MAIN_BRANCH} 完全一致（先 pull）`)
  }

  const current = workspaceVersion(await readFile('Cargo.toml', 'utf8'))
  if (!current || !SEMVER.test(current)) {
    throw new ReleaseError('Cargo.toml 里没有合法的 workspace 版本号')
  }
  const target = await targetVersion(current, positionals[0], values.yes === true)
  releaseTag = `v${target}`
  if (tryOutput('git', 'show-ref', '--verify', `refs/tags/${releaseTag}`) !== null) {
    throw new ReleaseError(`tag 已存在：${releaseTag}`)
  }
  if (!values['no-wait']) {
    run('gh', 'auth', 'status')
  }
  await confirm(releaseTag, values.yes === true)

  // 本地只做版本一致性检查：质量门禁与审计在 CI 里跑同一套，本地重复跑只是浪费时间。
  versionTouched = true
  run('bun', 'run', 'version:set', target)
  run('bun', 'run', 'check:versions', releaseTag)
  run('git', 'diff', '--check')

  const changed = output('git', 'diff', '--name-only', '--').split(/\r?\n/).filter(Boolean)
  const unexpected = changed.filter(
    (file) => !VERSION_FILES.includes(file as (typeof VERSION_FILES)[number]),
  )
  if (changed.length !== VERSION_FILES.length || unexpected.length > 0) {
    throw new ReleaseError(`版本写入改动了意料之外的文件：${changed.join('、') || '（无）'}`)
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
    console.log(`${releaseTag} 已推送；构建、签名与发布由 GitHub Actions 接管。`)
    return
  }

  const runId = await findWorkflowRun(releaseSha)
  run('gh', 'run', 'watch', runId, '--exit-status')
  const url = output('gh', 'release', 'view', releaseTag, '--json', 'url', '--jq', '.url')
  console.log(`发布成功 ${releaseTag}：${url}`)
}

main()
  .catch((error: unknown) => {
    rollback()
    console.error(error instanceof Error ? error.message : String(error))
    if (pushed) {
      console.error('远端回滚由 Release workflow 的失败清理步骤负责；失败详情见该步骤日志。')
    }
    process.exitCode = 1
  })
  .finally(() => terminal?.close())
