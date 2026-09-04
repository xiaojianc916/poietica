#!/usr/bin/env bun
/**
 * 在本机完成一次发布。
 *
 *   bun release              # 交互选择，默认 patch
 *   bun release minor        # 也可 patch / major / 具体版本号
 *   bun release 0.3.0 --yes  # 跳过确认
 *
 * 构建、签名、上传、验通道全部在本地用 gh 完成，不经过 GitHub Actions。
 * 代价是这台机器必须能完整构建（Rust 工具链 + 签名密钥），且构建的十几分钟里
 * 终端得开着；换来的是不依赖仓库 Secret、不等 CI 排队，失败立刻回滚。
 *
 * 步骤次序是有讲究的：门禁跑在写版本号之前。反过来的后果是门禁一失败，仓库就停在
 * 「版本号已提升、构建从未产出」的脏状态里，下一次发布凭空跳号。写版本号之后的任何
 * 失败——包括 Ctrl+C——这个脚本都会把那四个文件签回去，或者把那个 release 提交撤掉。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { bumped, compareVersions, SEMVER, workspaceVersion } from './version.ts'

const MAIN_BRANCH = 'main'
const CARGO = 'Cargo.toml'
const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const BUNDLE_DIR = 'target/x86_64-pc-windows-msvc/release/bundle/nsis'
const STAGE_DIR = 'dist-release'
const PLACEHOLDER_PUBKEY = 'REPLACE_WITH_TAURI_SIGNER_PUBKEY'

/**
 * version:set 会写的四个文件。
 *
 * 这份清单有两个用途：中途失败时原样签回去（起飞前检查已经保证工作区干净，所以
 * git restore 这四个文件不会误伤任何未提交的改动），以及提交时精确 add —— 发布
 * 提交里只该有版本号，不该把构建过程留下的任何东西顺手卷进去。
 */
const VERSION_FILES = [CARGO, 'package.json', 'apps/desktop/package.json', CONF] as const

/*
 * 签名密钥住在用户目录，不住在仓库里。
 *
 * 私钥进仓库等于把整条更新通道交出去：拿到它的人能签出一个客户端会自动信任、
 * 自动安装的「更新」。密码只在第一次运行时问一遍，此后脚本自己去取。
 */
const KEY_PATH = path.join(homedir(), '.tauri', 'poietica.key')
const PASS_PATH = path.join(homedir(), '.tauri', 'poietica.pass')

/** 预期内的失败：打印一句人话就退场，不甩堆栈。 */
class Abort extends Error {}

const terminal = createInterface({ input: process.stdin, output: process.stdout })

/** 版本号已写入、但还没提交。Ctrl+C 与异常路径都靠它决定要不要签回去。 */
let versionFilesDirty = false

function line(argv: readonly string[]): string {
  return argv.map((value) => (/\s/.test(value) ? JSON.stringify(value) : value)).join(' ')
}

/** 执行一条命令，输出直通终端。失败即抛。 */
function run(...argv: string[]): void {
  console.log(`    $ ${line(argv)}`)
  const [program, ...args] = argv
  const result = spawnSync(program ?? '', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Abort(`命令失败（退出码 ${result.status ?? '未知'}）：${line(argv)}`)
  }
}

/** 执行一条命令并拿回它的输出。失败返回 null，用于探测。 */
function capture(...argv: string[]): string | null {
  const [program, ...args] = argv
  const result = spawnSync(program ?? '', args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/** 回滚路径上用的命令：它自己失败了也不能再抛，否则会盖掉真正的错误。 */
function tryRun(...argv: string[]): void {
  console.log(`    $ ${line(argv)}`)
  const [program, ...args] = argv
  const result = spawnSync(program ?? '', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.log(`    回滚命令失败，请手动处理：${line(argv)}`)
  }
}

function restoreVersionFiles(): void {
  if (!versionFilesDirty) {
    return
  }
  console.log('')
  console.log('    正在把版本号改动签回去，仓库回到发布前的状态。')
  tryRun('git', 'restore', '--', ...VERSION_FILES)
  versionFilesDirty = false
}

function onInterrupt(): void {
  console.log('')
  console.log('已中断。')
  restoreVersionFiles()
  terminal.close()
  process.exit(130)
}

terminal.on('SIGINT', onInterrupt)
process.on('SIGINT', onInterrupt)

async function confirm(question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N'
  const answer = (await terminal.question(`    ${question} (${hint}) `)).trim().toLowerCase()
  if (answer === '') {
    return fallback
  }
  return answer === 'y' || answer === 'yes'
}

/**
 * 装载签名密钥。
 *
 * 优先用已经存在的环境变量，否则从用户目录读。密码缺失时问一次并存下来 ——
 * 那种「每次发版前先设两个环境变量」的流程迟早在某个深夜被跳过，而跳过的结果
 * 是一个没有 .sig 的发布，静默地断掉整条更新通道。
 */
async function loadSigningKey(): Promise<void> {
  if (!process.env['TAURI_SIGNING_PRIVATE_KEY']) {
    const key = await readFile(KEY_PATH, 'utf8').catch(() => null)
    if (key === null) {
      throw new Abort(
        [
          `找不到签名私钥：${KEY_PATH}`,
          '',
          '如果这是一台新机器，把旧机器上的这个文件拷过来；',
          '如果密钥从未生成过（注意：换密钥意味着所有老客户端都收不到更新了）：',
          '  cd apps/desktop && bun run tauri signer generate -w ~/.tauri/poietica.key',
        ].join('\n'),
      )
    }
    process.env['TAURI_SIGNING_PRIVATE_KEY'] = key.trim()
    console.log(`    已读取私钥 ${KEY_PATH}`)
  }

  if (process.env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] !== undefined) {
    return
  }
  const saved = await readFile(PASS_PATH, 'utf8').catch(() => null)
  if (saved !== null) {
    process.env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = saved.trim()
    console.log(`    已读取私钥密码 ${PASS_PATH}`)
    return
  }

  console.log('')
  console.log('    第一次运行，需要私钥密码。它会存进你的用户目录，以后不会再问。')
  const entered = (await terminal.question('    私钥密码（没有密码就直接回车）：')).trim()
  await mkdir(path.dirname(PASS_PATH), { recursive: true })
  await writeFile(PASS_PATH, entered, 'utf8')
  process.env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = entered
  console.log(`    已记住，存在 ${PASS_PATH}`)
}

/* ── [1] 起飞前检查 ────────────────────────────────────────── */

async function preflight(): Promise<{ branch: string; current: string }> {
  console.log('\n[1] 起飞前检查：确认这台机器可以安全地发一个版本')

  const rootPackage = JSON.parse(await readFile('package.json', 'utf8').catch(() => 'null')) as {
    name?: string
  }
  if (rootPackage?.name !== 'poietica') {
    throw new Abort('请在仓库根目录运行这个脚本。')
  }

  /* 当前版本从 Cargo workspace 读：check-versions 认定的单一真相在那里。 */
  const current = workspaceVersion(await readFile(CARGO, 'utf8'))
  if (!current || !SEMVER.test(current)) {
    throw new Abort(`读不到 ${CARGO} [workspace.package] 里的合法版本号。`)
  }

  const branch = capture('git', 'rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === null) {
    throw new Abort('git 不可用，或者这里不是一个 git 仓库。')
  }
  if (branch !== MAIN_BRANCH) {
    console.log(`    当前分支是 ${branch}，不是 ${MAIN_BRANCH}`)
    if (!(await confirm('仍然从这个分支发布？', false))) {
      throw new Abort('已取消。')
    }
  }

  const dirty = capture('git', 'status', '--porcelain=v1', '--untracked-files=all')
  if (dirty === null) {
    throw new Abort('git status 执行失败，无法确认工作区状态。')
  }
  if (dirty !== '') {
    throw new Abort('工作区有未提交的改动。发布必须来自一个确定的提交，请先提交或暂存。')
  }

  console.log('    正在与远端对表…')
  run('git', 'fetch', 'origin', '--tags', '--quiet')
  const behind = capture('git', 'rev-list', '--count', `HEAD..origin/${MAIN_BRANCH}`)
  if (behind !== '0' && behind !== null) {
    throw new Abort(`本地落后远端 ${behind} 个提交，请先 git pull。`)
  }

  if (capture('gh', '--version') === null) {
    throw new Abort('找不到 gh 命令。请先安装 GitHub CLI：https://cli.github.com')
  }
  if (capture('gh', 'auth', 'status') === null) {
    throw new Abort('gh 尚未登录。请先运行：gh auth login')
  }

  const conf = await readFile(CONF, 'utf8')
  if (conf.includes(PLACEHOLDER_PUBKEY)) {
    throw new Abort(
      [
        'updater 公钥还是占位符。',
        '发出去的后果是所有已安装客户端永远更新失败，而且不会有任何报错。',
        '生成密钥对：cd apps/desktop && bun run tauri signer generate -w ~/.tauri/poietica.key',
      ].join('\n'),
    )
  }

  await loadSigningKey()
  console.log('    通过。')
  return { branch, current }
}

/* ── [2] 选版本 ────────────────────────────────────────────── */

/** 交互菜单：只定预设，手动输入与校验留给调用方统一处理。 */
async function askPresetTarget(next: { patch: string; minor: string; major: string }) {
  console.log(`      1. 修订版  ${next.patch}   （修 bug、小改动）`)
  console.log(`      2. 次版本  ${next.minor}   （加功能）`)
  console.log(`      3. 主版本  ${next.major}   （不兼容变更）`)
  console.log('      4. 手动输入')
  for (;;) {
    const answer = (await terminal.question('    请输入序号：')).trim()
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

async function pickVersion(
  current: string,
  requested: string | undefined,
  yes: boolean,
): Promise<{ target: string; tag: string }> {
  console.log('\n[2] 选版本')
  const next = bumped(current)
  let target: string | undefined

  if (requested === undefined && !yes) {
    console.log(`    当前版本 ${current}`)
    target = await askPresetTarget(next)
  } else {
    const presets = new Map([
      ['patch', next.patch],
      ['minor', next.minor],
      ['major', next.major],
    ])
    target = presets.get(requested ?? 'patch') ?? requested
  }

  /* 手动输入写错就重问：门禁可能已经跑了十几分钟，不该因为一个笔误退场。 */
  while (target === undefined || !SEMVER.test(target)) {
    if (target !== undefined) {
      console.log(`    不是合法的版本号：${target}`)
    }
    target = (await terminal.question(`    输入版本号（如 ${next.patch}-beta.1）：`)).trim()
  }
  if (compareVersions(target, current) <= 0) {
    throw new Abort(`目标版本 ${target} 必须比当前版本 ${current} 新`)
  }

  const tag = `v${target}`

  /* 本地 tag 与远端 tag 都要看：只删了本地那份，push 时照样会撞车。 */
  const localTag = capture('git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`)
  const remoteTag = capture('git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`)
  if (localTag !== null || (remoteTag !== null && remoteTag !== '')) {
    throw new Abort(
      [
        `tag ${tag} 已经存在。`,
        '如果那次发布是失败的，先撤掉它：',
        `  gh release delete ${tag} --yes`,
        `  git push origin :refs/tags/${tag}`,
        `  git tag -d ${tag}`,
        '',
        '注意：已经发出去过的版本号不要复用。已经装上它的客户端不会再看到同号更新。',
      ].join('\n'),
    )
  }

  console.log(`    ${current} → ${target}`)
  if (!yes && !(await confirm('确认开始？'))) {
    throw new Abort('已取消。')
  }
  return { target, tag }
}

/* ── [3] 质量门禁（在写版本号之前）───────────────────────────── */

async function gate(): Promise<void> {
  console.log('\n[3] 质量门禁：lint、类型、测试、clippy 全跑一遍')
  console.log('    放在写版本号之前跑。门禁失败时仓库还没被动过，什么都不用回滚。')
  if (!(await confirm('现在跑完整门禁？（推荐）'))) {
    console.log('    已跳过门禁。')
    return
  }
  run('bun', 'run', 'check')
}

/* ── [4] 写版本号 ──────────────────────────────────────────── */

function applyVersion(target: string): void {
  console.log('\n[4] 写版本号')
  run('bun', 'run', 'version:set', target)
  versionFilesDirty = true
  run('bun', 'run', 'check:versions', `v${target}`)
}

function restoreVersion(): void {
  restoreVersionFiles()
}

/* ── [5][6][7] 清空、构建、收集产物 ─────────────────────────── */

async function buildAndStage(target: string, tag: string): Promise<string> {
  console.log('\n[5] 清空构建目录')
  console.log('    残留产物会让清单指向旧版本的安装包，签名照样能过，客户端会陷入更新死循环。')
  await rm(BUNDLE_DIR, { recursive: true, force: true })
  await rm(STAGE_DIR, { recursive: true, force: true })

  console.log('\n[6] 构建安装包：编译并用你的私钥签名（这一步最久，十几分钟起）')
  run('bun', 'run', 'build:release')
  /* 十几分钟没人会一直盯着终端。跑完敲一下铃，把人叫回来做后面的确认。 */
  process.stdout.write('')

  console.log('\n[7] 收集产物')
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
    throw new Abort(
      `构建目录里混进了其它版本的安装包（${strays.join(', ')}），此刻发布的东西不可信。`,
    )
  }
  if (!files.includes(`${installer}.sig`)) {
    throw new Abort(`缺少 ${installer}.sig。签名没有生成，检查私钥与密码是否正确。`)
  }

  await mkdir(STAGE_DIR, { recursive: true })
  for (const name of [installer, `${installer}.sig`]) {
    await copyFile(path.join(BUNDLE_DIR, name), path.join(STAGE_DIR, name))
  }
  run('bun', 'run', 'latest-json', BUNDLE_DIR, STAGE_DIR, tag)

  /*
   * 四个资产全部入账，不只安装包。
   *
   * 只给 exe 出校验和，等于对 latest.json 和 .sig 说「你俩自己看着办」——而它们
   * 恰恰是整条更新通道的信任来源。
   */
  const digests = new Map<string, string>()
  for (const name of (await readdir(STAGE_DIR)).sort()) {
    const bytes = await readFile(path.join(STAGE_DIR, name))
    digests.set(name, createHash('sha256').update(bytes).digest('hex'))
  }
  const sums = [...digests].map(([name, digest]) => `${digest}  ${name}`).join('\n')
  await writeFile(path.join(STAGE_DIR, 'SHA256SUMS.txt'), `${sums}\n`, 'utf8')

  const manifest = JSON.parse(await readFile(path.join(STAGE_DIR, 'latest.json'), 'utf8')) as {
    version?: string
    platforms?: Record<string, { url?: string }>
  }
  const size = (await stat(path.join(STAGE_DIR, installer))).size / 1024 / 1024
  console.log('')
  console.log(`    安装包   ${installer}`)
  console.log(`    体积     ${size.toFixed(1)} MB`)
  console.log(`    SHA256   ${digests.get(installer)?.slice(0, 16)}…`)
  console.log(`    校验和   ${digests.size} 个资产`)
  console.log(`    清单版本 ${manifest.version}`)
  console.log('')

  if (manifest.version !== target) {
    throw new Abort(`清单里的版本是 ${manifest.version}，不是 ${target}。`)
  }
  const url = manifest.platforms?.['windows-x86_64']?.url ?? ''
  if (!url.includes(installer)) {
    throw new Abort('清单指向的安装包和刚构建出来的这个对不上。')
  }

  console.log('    下一步会推送 tag 并创建 release —— 这是最后一个能无痕退出的地方。')
  if (!(await confirm('以上信息正确，继续发布？'))) {
    throw new Abort('已取消。产物留在 dist-release，未推送任何东西。')
  }
  return installer
}

/* ── [8][9][10] 提交打标、发布、验通道 ──────────────────────── */

async function publish(options: {
  branch: string
  tag: string
  installer: string
  yes: boolean
}): Promise<void> {
  const { branch, tag, installer, yes } = options
  const state = { committed: false, tagPushed: false }

  try {
    console.log('\n[8] 提交并打标')

    /*
     * 精确 add，不用 git add -A。
     *
     * 起飞前检查刚保证过工作区是干净的，那么此刻唯一该被提交的就是这四个文件；
     * -A 会把构建过程留下的任何未忽略产物一起卷进发布提交，而发布提交是要被
     * 打 tag 的 —— 它的内容必须是完全可预期的。
     */
    run('git', 'add', '--', ...VERSION_FILES)
    run('git', 'commit', '-m', `release: ${tag}`)
    state.committed = true
    versionFilesDirty = false

    run('git', 'tag', '-a', tag, '-m', tag)
    run('git', 'push', 'origin', branch, '--follow-tags')
    state.tagPushed = true

    console.log('\n[9] 发布：上传安装包、签名、清单、校验和到 GitHub Release')
    const prerelease = tag.includes('-')
    const createArgs = [
      'release',
      'create',
      tag,
      `${STAGE_DIR}/${installer}`,
      `${STAGE_DIR}/${installer}.sig`,
      `${STAGE_DIR}/latest.json`,
      `${STAGE_DIR}/SHA256SUMS.txt`,
      '--title',
      tag,
      '--generate-notes',
      prerelease ? '--prerelease' : '--latest',
    ]
    if (!yes && !(await confirm(`创建 ${prerelease ? '预发布' : '正式'} release ${tag}？`))) {
      throw new Abort(
        '已取消。tag 已推送，release 没建 —— 用 gh release create 补建，或按下面的撤回。',
      )
    }
    run('gh', ...createArgs)

    /* 预发布不进稳定通道，验了也对不上，跳过。 */
    if (!prerelease) {
      console.log('\n[10] 验证更新通道：用客户端真正会去访问的那条地址确认新版本')
      run('bun', 'run', 'verify:channel', tag)
    }
  } catch (error) {
    await unwind({ branch, tag, state, error })
    throw new Abort('发布未完成。')
  }
}

/**
 * 把已经推出去的半个发布收回来。
 *
 * 顺序是从外往里：release → 远端 tag → 本地 tag → 版本号提交。最后那一步分两种情况，
 * 因为推没推出去决定了能不能直接把提交抹掉。
 */
async function unwind(options: {
  branch: string
  tag: string
  state: { committed: boolean; tagPushed: boolean }
  error: unknown
}): Promise<void> {
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
    restoreVersion()
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

/* ── 编排 ──────────────────────────────────────────────────── */

function printHelp(): void {
  console.log(
    [
      '用法：bun release [patch|minor|major|版本号] [--yes]',
      '',
      '本机发布：构建、签名、上传、验通道全在本地完成，不经过 GitHub Actions。',
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

  const { branch, current } = await preflight()
  const { target, tag } = await pickVersion(current, positionals[0], values.yes === true)

  await gate()

  try {
    applyVersion(target)
    const installer = await buildAndStage(target, tag)
    await publish({ branch, tag, installer, yes: values.yes === true })
  } finally {
    restoreVersion()
  }

  console.log('')
  console.log(`  ${tag} 发布完成。`)
  const releaseUrl = capture('gh', 'release', 'view', tag, '--json', 'url', '--jq', '.url')
  if (releaseUrl) {
    console.log(`  ${releaseUrl}`)
  }
  console.log('')
  console.log('  还剩下机器做不了的那一步：')
  console.log('    1. 打开已经装着旧版本的 Poietica')
  console.log('    2. 等出现更新提示（启动后 30 秒内）')
  console.log('    3. 点它，看进度填满，再点重启')
  console.log(`    4. 重启后确认版本号已经是 ${target}`)
  console.log('')
}

main()
  .catch((error: unknown) => {
    console.error('')
    console.error(error instanceof Abort ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => terminal.close())
