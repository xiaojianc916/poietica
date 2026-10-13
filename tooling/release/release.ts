#!/usr/bin/env bun
/**
 * 在本机完成一次发布：bun release [patch|minor|major|版本号] [--yes] [--draft]
 *
 * 构建、上传、验通道全部在本地用 gh 完成：不依赖仓库 Secret、不等 CI 排队，失败立刻回滚；
 * 代价是构建的十几分钟里终端得开着。`.github/workflows/release.yml` 那条链由 tag 触发、
 * 只建草稿，这条链默认直接发正式版。
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import {
  type Bump,
  bumped,
  compareVersions,
  LOCK_FILES,
  packageVersion,
  SEMVER,
  VERSION_FILES,
  VERSION_SOURCE,
} from './version'

const MAIN_BRANCH = 'main'
const BUNDLE_DIR = 'apps/desktop/release'
const STAGE_DIR = 'dist-release'
/* 本脚本由 bun 跑起来，process.execPath 就是那个 bun —— 不指望 PATH 上恰好还有一个。 */
const BUN = process.execPath

class Abort extends Error {}

/** 版本号已写入、但还没提交。Ctrl+C 与异常路径都靠它决定要不要签回去。 */
let versionFilesDirty = false

function line(argv: readonly string[]): string {
  return argv.map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(' ')
}

/** onFail 决定失败时抛 Abort 还是只记一句（回滚路径不能再抛）。 */
function spawn(argv: readonly string[], onFail: 'throw' | 'log'): void {
  console.log(`    $ ${line(argv)}`)
  const [program, ...args] = argv
  const result = spawnSync(program ?? '', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    if (onFail === 'throw') {
      throw new Abort(`命令失败（退出码 ${result.status ?? '未知'}）：${line(argv)}`)
    }
    console.log(`    回滚命令失败，请手动处理：${line(argv)}`)
  }
}

function run(...argv: string[]): void {
  spawn(argv, 'throw')
}

/** 失败返回 null，用于探测。 */
function capture(...argv: string[]): string | null {
  const [program, ...args] = argv
  const result = spawnSync(program ?? '', args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

const tryRun = (...argv: string[]): void => spawn(argv, 'log')

/**
 * **一次提问开一个 readline，问完就关**。
 *
 * gh auth login 这类命令要独占终端，常驻的 readline 会一直占着 stdin，两个读者互相吃键；
 * 而 readline 一旦 close 就暂停了 stdin，「关掉再重开」会让下一个问题永远等不到回车（实测卡死）。
 */
async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })

  try {
    return (await terminal.question(question)).trim()
  } finally {
    terminal.close()
  }
}

/** 跑一条要独占终端的交互式命令；此时没有任何 readline 活着，stdin 完整地归它。 */
function interactive(...argv: string[]): void {
  const [program, ...args] = argv
  const result = spawnSync(program ?? '', args, { stdio: 'inherit' })

  if (result.status !== 0) {
    throw new Abort(`命令失败（退出码 ${result.status ?? '未知'}）：${line(argv)}`)
  }
}

function restoreVersionFiles(): void {
  if (!versionFilesDirty) {
    return
  }
  console.log('')
  console.log('    正在把版本号改动签回去，仓库回到发布前的状态。')
  tryRun('git', 'restore', '--', ...VERSION_FILES, ...LOCK_FILES)
  versionFilesDirty = false
}

function onInterrupt(): void {
  console.log('')
  console.log('已中断。')
  restoreVersionFiles()
  process.exit(130)
}

process.on('SIGINT', onInterrupt)

async function confirm(question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N'
  const answer = (await ask(`    ${question} (${hint}) `)).toLowerCase()

  if (answer === '') {
    return fallback
  }
  return answer === 'y' || answer === 'yes'
}

/**
 * 这一版刻意不签名：没有证书，SmartScreen 会对每个用户弹一次「未知发布者」。
 * CSC_LINK 一旦被设上，electron-builder 就会用那把证书签 —— 那不是本流程的决定。
 */
function reportSigning(): void {
  if (process.env.CSC_LINK === undefined) {
    console.log('    CSC_LINK 未设置：按 15 页 §10.4 的决定，这一版不签名（SmartScreen 会提示未知发布者）')
    return
  }
  console.log('    CSC_LINK 已设置：这一版会用环境变量里的证书签名')
}

async function readCurrentVersion(): Promise<string> {
  const current = packageVersion(await readFile(VERSION_SOURCE, 'utf8').catch(() => ''))

  if (!current || !SEMVER.test(current)) {
    throw new Abort(`${VERSION_SOURCE} 里读不到合法的语义化版本号。`)
  }
  return current
}

async function checkBranch(): Promise<string> {
  const branch = capture('git', 'rev-parse', '--abbrev-ref', 'HEAD')

  if (branch === null) {
    throw new Abort('git 不可用，或者这里不是一个 git 仓库。')
  }
  if (branch === MAIN_BRANCH) {
    return branch
  }

  console.log(`    当前分支是 ${branch}，不是 ${MAIN_BRANCH}`)
  if (!(await confirm('仍然从这个分支发布？', false))) {
    throw new Abort('已取消。')
  }
  return branch
}

function checkWorkingTree(): void {
  const dirty = capture('git', 'status', '--porcelain=v1', '--untracked-files=all')

  if (dirty === null) {
    throw new Abort('git status 执行失败，无法确认工作区状态。')
  }
  if (dirty !== '') {
    throw new Abort('工作区有未提交的改动。发布必须来自一个确定的提交，请先提交或暂存。')
  }
}

function syncWithRemote(): void {
  console.log('    正在与远端对表…')
  run('git', 'fetch', 'origin', '--tags', '--quiet')

  const behind = capture('git', 'rev-list', '--count', `HEAD..origin/${MAIN_BRANCH}`)
  if (behind !== '0' && behind !== null) {
    throw new Abort(`本地落后远端 ${behind} 个提交，请先 git pull。`)
  }
}

/**
 * 没登录就地登录，不把人踢出去：这条链已经跑了十几分钟，因为一个能当场做完的步骤退场，
 * 整条链就得从头再跑。非交互终端（CI、管道）下 gh 问不了问题，那时才如实报错。
 */
async function requireGh(): Promise<void> {
  if (capture('gh', '--version') === null) {
    throw new Abort('找不到 gh 命令。请先安装 GitHub CLI：https://cli.github.com')
  }
  if (capture('gh', 'auth', 'status') !== null) {
    return
  }

  console.log('')
  console.log('    gh 尚未登录，现在开始登录；登录完成后发布流程会自己继续。')

  if (process.stdin.isTTY !== true) {
    throw new Abort('当前不是交互终端，无法就地登录。请先运行：gh auth login')
  }

  interactive('gh', 'auth', 'login')

  if (capture('gh', 'auth', 'status') === null) {
    throw new Abort('gh 登录没有完成。请手动运行：gh auth login')
  }

  console.log('    登录完成，继续发布。')
}

async function preflight(): Promise<{ branch: string; current: string }> {
  console.log('\n[1] 起飞前检查：确认这台机器可以安全地发一个版本')

  const rootPackage = JSON.parse(await readFile('package.json', 'utf8').catch(() => 'null')) as {
    name?: string
  } | null
  if (rootPackage?.name !== 'poietica') {
    throw new Abort('请在仓库根目录运行这个脚本。')
  }

  const current = await readCurrentVersion()
  const branch = await checkBranch()

  checkWorkingTree()
  syncWithRemote()
  await requireGh()
  reportSigning()

  console.log('    通过。')
  return { branch, current }
}

async function askPresetTarget(next: { patch: string; minor: string; major: string }): Promise<string | undefined> {
  console.log(`      1. 修订版  ${next.patch}   （修 bug、小改动）`)
  console.log(`      2. 次版本  ${next.minor}   （加功能）`)
  console.log(`      3. 主版本  ${next.major}   （不兼容变更）`)
  console.log('      4. 手动输入')
  for (;;) {
    const answer = await ask('    请输入序号：')
    if (answer === '1') {
      return next.patch
    }
    if (answer === '2') {
      return next.minor
    }
    if (answer === '3') {
      return next.major
    }
    if (answer === '4') {
      return undefined
    }
    console.log('    序号不在范围内，再试一次。')
  }
}

/**
 * 本地 tag 与远端 tag 都要看：只删了本地那份，push 时照样会撞车。
 * 已经发出去过的版本号不要复用 —— 已经装上它的客户端不会再看到同号更新。
 */
function assertTagFree(tag: string): void {
  const localTag = capture('git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`)
  const remoteTag = capture('git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`)

  if (localTag === null && (remoteTag === null || remoteTag === '')) {
    return
  }
  throw new Abort(
    [
      `tag ${tag} 已经存在。`,
      '如果那次发布是失败的，先撤掉它：',
      `  gh release delete ${tag} --yes`,
      `  git push origin :refs/tags/${tag}`,
      `  git tag -d ${tag}`,
    ].join('\n'),
  )
}

function targetFromPresets(next: Bump, requested: string | undefined): string {
  const presets = new Map([
    ['patch', next.patch],
    ['minor', next.minor],
    ['major', next.major],
  ])
  return presets.get(requested ?? 'patch') ?? requested ?? next.patch
}

async function resolveTarget(current: string, requested: string | undefined, yes: boolean): Promise<string> {
  const next = bumped(current)

  if (requested === undefined && !yes) {
    console.log(`    当前版本 ${current}`)
    return (await askPresetTarget(next)) ?? ''
  }
  return targetFromPresets(next, requested)
}

async function pickVersion(
  current: string,
  requested: string | undefined,
  yes: boolean,
): Promise<{ target: string; tag: string }> {
  console.log('\n[2] 选版本')
  const next = bumped(current)
  let target = await resolveTarget(current, requested, yes)

  /* 手动输入写错就重问：门禁可能已经跑了十几分钟，不该因为一个笔误退场。 */
  while (!SEMVER.test(target)) {
    if (target !== '') {
      console.log(`    不是合法的版本号：${target}`)
    }
    target = await ask(`    输入版本号（如 ${next.patch}-beta.1）：`)
  }
  if (compareVersions(target, current) <= 0) {
    throw new Abort(`目标版本 ${target} 必须比当前版本 ${current} 新`)
  }

  const tag = `v${target}`
  assertTagFree(tag)

  console.log(`    ${current} → ${target}`)
  if (!yes && !(await confirm('确认开始？'))) {
    throw new Abort('已取消。')
  }
  return { target, tag }
}

async function gate(): Promise<void> {
  console.log('\n[3] 质量门禁：类型、lint、依赖规则、全部测试')
  console.log('    放在写版本号之前跑。门禁失败时仓库还没被动过，什么都不用回滚。')
  if (!(await confirm('现在跑完整门禁？（推荐）'))) {
    console.log('    已跳过门禁。')
    return
  }
  run(BUN, 'run', 'check')
}

function applyVersion(target: string): void {
  console.log('\n[4] 写版本号')
  run(BUN, 'run', 'version:set', target)
  versionFilesDirty = true
  run(BUN, 'run', 'check:versions', `v${target}`)
}

/**
 * 打出来的包里 node_modules 只该有运行时真正 import 的那几个。
 *
 * 打包器另有一个只认否定模式的 matcher，会把生产依赖树整棵塞进 asar：谁往 apps/desktop 的
 * dependencies 里放一个渲染层依赖，安装包就悄悄胖几十 MB，而构建照样绿。这个闸门让那次误加
 * 在打包后立刻现形。`@lydell/node-pty` 被 features/terminal/src/host 动态加载，electron-updater
 * 只在打包版由 features/update/src/host 加载；其余依赖都已被 electron-vite 内联进 out/**。
 */
const RUNTIME_DEPENDENCIES = ['@lydell/node-pty', 'electron-updater']

const RUNTIME_DEPENDENCY_CLOSURE = [
  'builder-util-runtime',
  'fs-extra',
  'graceful-fs',
  'jsonfile',
  'universalify',
  'js-yaml',
  'argparse',
  'semver',
  'lazy-val',
  'lodash.escaperegexp',
  'lodash.isequal',
  'tiny-typed-emitter',
  'sax',
  'debug',
  'ms',
  '@lydell/node-pty-win32-x64',
]

/**
 * 直接读 asar 的头部清单，不依赖外部命令：发布链要能离线跑。
 * 布局是 [16 字节头][JSON 目录][补齐到 4 字节][文件数据]，JSON 的字节数在偏移 12。
 * 要 original-fs：在 Electron 进程里 node:fs 会把 .asar 当目录接管。
 */
function asarNodeModules(archive: string): string[] {
  const fd = openSync(archive, 'r')

  try {
    const head = Buffer.alloc(16)

    if (readSync(fd, head, 0, 16, 0) !== 16) {
      throw new Abort(`${archive} 读不到 asar 头部。`)
    }

    const jsonBytes = head.readUInt32LE(12)
    const directory = Buffer.alloc(jsonBytes)

    readSync(fd, directory, 0, jsonBytes, 16)

    const header = JSON.parse(directory.toString('utf8')) as {
      files?: {
        node_modules?: { files?: Record<string, { files?: Record<string, unknown> } | undefined> }
      }
    }
    const entries = header.files?.node_modules?.files ?? {}
    const names: string[] = []

    for (const [name, entry] of Object.entries(entries)) {
      /* 作用域包在 asar 里是「@scope/包名」两层：@scope 目录本身不是一个依赖。 */
      if (name.startsWith('@')) {
        for (const child of Object.keys(entry?.files ?? {})) {
          names.push(`${name}/${child}`)
        }
        continue
      }
      names.push(name)
    }
    return names
  } finally {
    closeSync(fd)
  }
}

function assertLeanPackage(): void {
  const archive = path.join(BUNDLE_DIR, 'win-unpacked', 'resources', 'app.asar')
  const expected = new Set([...RUNTIME_DEPENDENCIES, ...RUNTIME_DEPENDENCY_CLOSURE])
  const found = asarNodeModules(archive)
  const unexpected = found.filter((name) => !expected.has(name))

  if (unexpected.length > 0) {
    throw new Abort(
      [
        `asar 里混进了 ${unexpected.length} 个不该随包发布的依赖：${unexpected.join(', ')}`,
        '',
        '多半是往 apps/desktop/package.json 的 dependencies 里加了东西。',
        '渲染层依赖（进 out/**）与主进程依赖（也被 electron-vite 打进 out/**）请放 devDependencies：',
        `唯一该留在 dependencies 的是 ${RUNTIME_DEPENDENCIES.join('、')}。`,
      ].join('\n'),
    )
  }

  console.log(`    包内依赖 ${found.length} 个，符合预期。`)
}

async function resolveInstaller(target: string): Promise<string> {
  const files = await readdir(BUNDLE_DIR).catch(() => [] as string[])
  const installers = files.filter((name) => name.endsWith('-setup.exe'))
  const installer = installers.find((name) => name.includes(`_${target}_`))

  if (!installer) {
    throw new Abort(
      installers.length === 0
        ? `${BUNDLE_DIR} 下没有生成任何安装包。`
        : `没有找到 ${target} 的安装包，只找到：${installers.join(', ')}`,
    )
  }

  const strays = installers.filter((name) => name !== installer)
  if (strays.length > 0) {
    throw new Abort(`构建目录里混进了其它版本的安装包（${strays.join(', ')}），此刻发布的东西不可信。`)
  }

  const blockmap = `${installer}.blockmap`
  if (!files.includes(blockmap)) {
    throw new Abort(`没有生成 ${blockmap}：electron-builder.yml 的 nsis.differentialPackage 被关掉了。`)
  }
  return installer
}

async function stageInstaller(installer: string): Promise<void> {
  await mkdir(STAGE_DIR, { recursive: true })
  await copyFile(path.join(BUNDLE_DIR, installer), path.join(STAGE_DIR, installer))
  await copyFile(path.join(BUNDLE_DIR, `${installer}.blockmap`), path.join(STAGE_DIR, `${installer}.blockmap`))
}

async function reportAssets(installer: string): Promise<{
  version?: string
  path?: string
  sha512?: string
}> {
  const digests = new Map<string, string>()

  for (const name of (await readdir(STAGE_DIR)).sort()) {
    const bytes = await readFile(path.join(STAGE_DIR, name))
    digests.set(name, Bun.SHA256.hash(bytes, 'hex'))
  }

  const manifest = Bun.YAML.parse(await readFile(path.join(STAGE_DIR, 'latest.yml'), 'utf8')) as {
    version?: string
    path?: string
    sha512?: string
  }
  const size = (await stat(path.join(STAGE_DIR, installer))).size / 1024 / 1024

  console.log('')
  console.log(`    安装包   ${installer}`)
  console.log(`    体积     ${size.toFixed(1)} MB`)
  console.log(`    SHA256   ${digests.get(installer)?.slice(0, 16)}…`)
  console.log(`    校验和   ${digests.size} 个资产`)
  for (const name of [...digests.keys()].sort()) {
    console.log(`             ${name}`)
  }
  console.log(`    清单版本 ${manifest.version}`)
  console.log('')
  return manifest
}

async function buildAndStage(target: string, tag: string, current: string): Promise<string> {
  console.log('\n[5] 清空构建目录')
  console.log('    残留产物会让清单指向旧版本的安装包，校验照样能过，客户端会陷入更新死循环。')
  await rm(BUNDLE_DIR, { recursive: true, force: true })
  await rm(STAGE_DIR, { recursive: true, force: true })

  console.log('\n[6] 构建安装包（这一步最久，编译 Core 与界面）')
  run(BUN, 'run', 'build:release')
  assertLeanPackage()
  /* 十几分钟没人会一直盯着终端。跑完敲一下铃，把人叫回来做后面的确认。 */
  process.stdout.write('\u0007')

  console.log('\n[7] 收集产物')
  const installer = await resolveInstaller(target)
  await stageInstaller(installer)
  await stagePreviousBlockmap(current)
  run(BUN, 'run', 'latest-json', BUNDLE_DIR, STAGE_DIR, tag)

  const manifest = await reportAssets(installer)

  if (manifest.version !== target) {
    throw new Abort(`清单里的版本是 ${manifest.version}，不是 ${target}。`)
  }
  if (manifest.path !== installer || !manifest.sha512) {
    throw new Abort('清单指向的安装包和刚构建出来的这个对不上。')
  }

  console.log('    下一步会推送 tag 并创建 release —— 这是最后一个能无痕退出的地方。')
  if (!(await confirm('以上信息正确，继续发布？'))) {
    throw new Abort('已取消。产物留在 dist-release，未推送任何东西。')
  }
  return installer
}

/**
 * 差分下载要两份块索引：这一版的，与上一个版本的那一份。旧的那份从上一个 release 取回来、按原名字
 * 放进这一版的资产里：客户端按「新版本资产名里把版本号换成旧版本号」拼地址（electron-updater 的
 * providers/Provider.ts），拼出来仍落在这一版的 tag 目录下。它没法用这一版的块索引顶替 ——
 * 块索引是内容寻址的，顶替的后果不是报错，是客户端照一份错的比对表拼出文件、末了 sha512 校验不过、
 * 退回整包下载，比不做差分还慢。取不到不算失败：这一版就是第一个带块索引的版本时，客户端整包下载一次。
 */
async function stagePreviousBlockmap(previousVersion: string): Promise<void> {
  const previousTag = `v${previousVersion}`
  const listed = capture('gh', 'release', 'view', previousTag, '--json', 'assets', '--jq', '.assets[].name')
  const name = (listed ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((candidate) => candidate.endsWith('-setup.exe.blockmap') && candidate.includes(`_${previousVersion}_`))

  if (name === undefined || name.length === 0) {
    console.log(`    ${previousTag} 没有块索引：这一版不带差分基准，客户端整包下载一次`)
    return
  }

  /* gh 直接把字节写进 stage：capture 按文本读，二进制会坏在半路。 */
  if (capture('gh', 'release', 'download', previousTag, '--pattern', name, '--dir', STAGE_DIR) === null) {
    console.log(`    取不到 ${previousTag} 的 ${name}：这一版不带差分基准`)
    return
  }

  /* 取回来的必须真是块索引，别让一份坏比对表跟着这一版发给所有客户端。 */
  try {
    const parsed = JSON.parse(Bun.gunzipSync(await readFile(path.join(STAGE_DIR, name))).toString()) as {
      files?: unknown
    }

    if (!Array.isArray(parsed.files)) {
      throw new Error('块索引里没有 files')
    }
  } catch (cause) {
    console.warn(`    ${name} 不是一份能用的块索引，这一版不带差分基准`, cause)
    await rm(path.join(STAGE_DIR, name), { force: true })
  }
}

type PublishState = { committed: boolean; tagPushed: boolean }

async function commitAndTag(tag: string, branch: string, state: PublishState): Promise<void> {
  console.log('\n[8] 提交并打标')

  /* 精确 add 不用 -A：发布提交要被打 tag，-A 会把构建留下的产物卷进内容不可预期的提交。 */
  run('git', 'add', '--', ...VERSION_FILES, ...LOCK_FILES)
  run('git', 'commit', '-m', `release: ${tag}`)
  state.committed = true
  versionFilesDirty = false

  run('git', 'tag', '-a', tag, '-m', tag)
  run('git', 'push', 'origin', branch, '--follow-tags')
  state.tagPushed = true
}

async function createRelease(tag: string, installer: string, yes: boolean, draft: boolean): Promise<void> {
  console.log('\n[9] 发布：上传安装包、清单、校验和到 GitHub Release')

  const blockmaps = (await readdir(STAGE_DIR)).filter((name) => name.endsWith('.blockmap'))
  const createArgs = [
    'release',
    'create',
    tag,
    `${STAGE_DIR}/${installer}`,
    `${STAGE_DIR}/latest.yml`,
    `${STAGE_DIR}/SHA256SUMS.txt`,
    ...blockmaps.map((name) => `${STAGE_DIR}/${name}`),
    '--title',
    tag,
    '--generate-notes',
  ]

  const prerelease = tag.includes('-')
  if (draft) {
    createArgs.push('--draft')
  } else if (prerelease) {
    createArgs.push('--prerelease')
  } else {
    createArgs.push('--latest')
  }

  const label = draft ? '草稿' : prerelease ? '预发布' : '正式'
  if (!yes && !(await confirm(`创建${label} release ${tag}？`))) {
    throw new Abort('已取消。tag 已推送，release 没建 —— 用 gh release create 补建，或按下面的撤回。')
  }
  run('gh', ...createArgs)
}

async function publish(options: {
  branch: string
  tag: string
  installer: string
  yes: boolean
  draft: boolean
}): Promise<void> {
  const { branch, tag, installer, yes, draft } = options
  const state: PublishState = { committed: false, tagPushed: false }

  try {
    await commitAndTag(tag, branch, state)
    await createRelease(tag, installer, yes, draft)

    /* 草稿与预发布都不进稳定通道，验了也对不上，跳过。 */
    if (!draft && !tag.includes('-')) {
      console.log('\n[10] 验证更新通道：用客户端真正会去访问的那条地址确认新版本')
      run(BUN, 'run', 'verify:channel', tag)
    }
  } catch (error) {
    await unwind({ branch, tag, state, error })
    throw new Abort('发布未完成。')
  }
}

/**
 * 顺序是从外往里：release → 远端 tag → 本地 tag → 版本号提交；最后一步分两种情况，
 * 因为推没推出去决定了能不能直接把提交抹掉。
 */
async function unwind(options: { branch: string; tag: string; state: PublishState; error: unknown }): Promise<void> {
  const { branch, tag, state, error } = options
  console.log('')
  console.log(`发布中断：${error instanceof Error ? error.message : String(error)}`)
  console.log('')

  if (!(await confirm('要撤回这次发布吗？（删除 release、tag，并回退版本号提交）', true))) {
    console.log(`已保留现场。tag ${tag} 与版本号提交仍在。`)
    return
  }

  if (capture('gh', 'release', 'view', tag) !== null) {
    tryRun('gh', 'release', 'delete', tag, '--yes')
  }
  if (state.tagPushed) {
    tryRun('git', 'push', 'origin', `:refs/tags/${tag}`)
  }
  if (capture('git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`) !== null) {
    tryRun('git', 'tag', '-d', tag)
  }

  if (!state.committed) {
    restoreVersionFiles()
    return
  }
  if (state.tagPushed) {
    /* 提交已经在远端，历史不能改写，只能再补一个反向提交。 */
    tryRun('git', 'revert', '--no-edit', 'HEAD')
    tryRun('git', 'push', 'origin', branch)
    console.log(`已撤回 ${tag}，并推送了一个 revert 提交。`)
    return
  }

  /* 还没推出去：直接把这个本地提交抹掉，版本号回到发布前。 */
  tryRun('git', 'reset', '--hard', 'HEAD~1')
  console.log(`已撤回 ${tag}，版本号提交已丢弃，仓库回到发布前的状态。`)
}

function printHandover(target: string, tag: string, draft: boolean): void {
  console.log('')
  console.log(`  ${tag} ${draft ? '已建为草稿' : '发布完成'}。`)

  if (!draft) {
    const releaseUrl = capture('gh', 'release', 'view', tag, '--json', 'url', '--jq', '.url')
    if (releaseUrl) {
      console.log(`  ${releaseUrl}`)
    }
  }

  console.log('')
  if (draft) {
    console.log('  草稿对客户端不可见（15 页 §10.5）。人工验收通过后转正：')
    console.log(`    gh release edit ${tag} --draft=false --latest`)
    console.log('')
  }
  console.log('  还剩下机器做不了的那一步（16 页 §7 发布清单）：')
  console.log('    1. 打开已经装着旧版本的 Poietica')
  console.log('    2. 等出现更新提示')
  console.log('    3. 点它，看进度填满，再点重启')
  console.log(`    4. 重启后确认版本号已经是 ${target}`)
  console.log('')
}

function printHelp(): void {
  console.log(
    [
      '用法：bun release [patch|minor|major|版本号] [--yes] [--draft]',
      '',
      '本机发布：构建、上传、验通道全在本地完成，不经过 GitHub Actions。',
      '  --yes    跳过所有确认',
      '  --draft  建草稿而不是正式发布（人工验收后再转正）',
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
      draft: { type: 'boolean' },
    },
  })
  if (values.help) {
    printHelp()
    return
  }
  if (positionals.length > 1) {
    throw new Abort('最多只能指定一个版本参数')
  }

  console.log('\nPoietica 发布流程 · 本地构建 + gh 发布\n')

  const yes = values.yes === true
  const draft = values.draft === true
  const { branch, current } = await preflight()
  const { target, tag } = await pickVersion(current, positionals[0], yes)

  await gate()

  try {
    applyVersion(target)
    const installer = await buildAndStage(target, tag, current)
    await publish({ branch, tag, installer, yes, draft })
  } finally {
    restoreVersionFiles()
  }

  printHandover(target, tag, draft)
}

main().catch((error: unknown) => {
  console.error('')
  console.error(error instanceof Abort ? error.message : String(error))
  process.exitCode = 1
})
