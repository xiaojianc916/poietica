#!/usr/bin/env bun
/**
 * 在本机完成一次发布。
 *
 *   bun run release
 *
 * 构建、签名、上传、验通道全部在本地用 gh 完成，不经过 GitHub Actions。
 *
 * 这条路径绕过了 release.yml 里的静默安装冒烟测试与依赖审计，代价自负；换来的是
 * 不依赖仓库 Secret、不用等 CI 排队，以及失败时能立刻回滚。
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

/*
 * SEMVER 与 bumped 不在这里重新写一遍。
 *
 * scripts/release/version.mjs 早就导出了它们，而且它那份是对的：bumped 先
 * split('-')[0] 再自增。上一版这里手抄了一份漏掉那一步的，当前版本一旦带预发布号
 * （0.2.0-beta.1），Number('0-beta') 是 NaN，菜单会给出 0.2.NaN。
 */
import { bumped, SEMVER } from './version.ts'

const MAIN_BRANCH = 'main'
const CARGO = 'Cargo.toml'
const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const RELEASE_DIR = 'target/x86_64-pc-windows-msvc/release'
const BUNDLE_DIR = `${RELEASE_DIR}/bundle/nsis`
/* 更新载荷的基线是安装器装出去的那个 exe，不是安装器自己（manifest.ts 的 argv 契约）。 */
const RELEASE_EXE = `${RELEASE_DIR}/poietica.exe`
const STAGE_DIR = 'dist-release'
const PLACEHOLDER_PUBKEY = 'REPLACE_WITH_TAURI_SIGNER_PUBKEY'
const TOTAL_STEPS = 10

/** [workspace.package] 段里那个 version —— 全仓库版本号的唯一真相。 */
const CARGO_VERSION = /^version\s*=\s*"([^"]+)"/m

/**
 * version:set 会写的四个文件。
 *
 * 这份清单有两个用途：中途失败时原样签回去（起飞前检查已经保证工作区干净，所以
 * git restore 这四个文件不会误伤任何未提交的改动），以及提交时精确 add —— 发布
 * 提交里只该有版本号，不该把构建过程留下的任何东西顺手卷进去。
 */
const VERSION_FILES = [CARGO, 'package.json', 'apps/desktop/package.json', CONF]

/*
 * 签名密钥住在用户目录，不住在仓库里。
 *
 * 私钥进仓库等于把整条更新通道交出去：拿到它的人能签出一个你的客户端会自动信任、
 * 自动安装的「更新」。放在这里还有一个好处——密码只需要在第一次运行时输一遍，此后
 * 脚本自己去取，不必每开一个终端窗口就重设两个环境变量。
 */
const KEY_PATH = path.join(homedir(), '.tauri', 'poietica.key')
const PASS_PATH = path.join(homedir(), '.tauri', 'poietica.pass')

const color = process.stdout.isTTY && !process.env['NO_COLOR']
const paint = (code: string, text: string): string =>
  color ? `\u001B[${code}m${text}\u001B[0m` : text
const bold = (text: string): string => paint('1', text)
const dim = (text: string): string => paint('2', text)
const red = (text: string): string => paint('31', text)
const green = (text: string): string => paint('32', text)
const yellow = (text: string): string => paint('33', text)
const cyan = (text: string): string => paint('36', text)

/** 预期内的失败：打印一句人话就退场，不甩堆栈。 */
class Abort extends Error {}

const rl = createInterface({ input: process.stdin, output: process.stdout })

const startedAt = Date.now()
let stepIndex = 0
let stepStartedAt = 0

/** 版本号已写入、但还没提交。Ctrl+C 与异常路径都靠它决定要不要签回去。 */
let versionFilesDirty = false

function elapsed(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000)

  if (seconds < 60) {
    return `${seconds}s`
  }

  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** 每一步开头的那行中文。顺带给上一步结个账：哪一步慢，跑几次就心里有数了。 */
function step(title: string): void {
  if (stepStartedAt !== 0) {
    console.log(dim(`    ✓ 用时 ${elapsed(stepStartedAt)}`))
  }

  stepIndex += 1
  stepStartedAt = Date.now()
  console.log('')
  console.log(`${bold(`[${stepIndex}/${TOTAL_STEPS}]`)} ${bold(title)}`)
}

function note(text: string): void {
  console.log(dim(`    ${text}`))
}

/* bun、git、gh 在 Windows 上都是真正的可执行文件，argv 直接交给 spawnSync，不经 shell。 */
const line = (argv: readonly string[]): string => argv.join(' ')

/** 执行一条命令，输出直通终端。失败即抛。 */
function run(...argv: string[]): void {
  const [program = '', ...rest] = argv
  const command = line(argv)
  console.log(dim(`    $ ${command}`))

  const result = spawnSync(program, rest, { stdio: 'inherit' })

  if (result.status !== 0) {
    throw new Abort(`命令失败（退出码 ${result.status}）：${command}`)
  }
}

/** 执行一条命令并拿回它的输出。失败返回 null，用于探测。 */
function capture(...argv: string[]): string | null {
  const [program = '', ...rest] = argv
  const result = spawnSync(program, rest, { encoding: 'utf8' })

  return result.status === 0 ? result.stdout.trim() : null
}

/** 回滚路径上用的命令：它自己失败了也不能再抛，否则会盖掉真正的错误。 */
function tryRun(...argv: string[]): void {
  const [program = '', ...rest] = argv
  const command = line(argv)
  console.log(dim(`    $ ${command}`))

  const result = spawnSync(program, rest, { stdio: 'inherit' })

  if (result.status !== 0) {
    console.log(yellow(`    回滚命令失败，请手动处理：${command}`))
  }
}

async function confirm(question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N'
  const answer = (await rl.question(`    ${question} (${hint}) `)).trim().toLowerCase()

  if (answer === '') {
    return fallback
  }

  return answer === 'y' || answer === 'yes'
}

async function choose(
  question: string,
  options: ReadonlyArray<{ label: string; value: string | null }>,
): Promise<string | null> {
  console.log(`    ${question}`)

  options.forEach((option, index) => {
    console.log(`      ${cyan(String(index + 1))}. ${option.label}`)
  })

  for (;;) {
    const answer = (await rl.question('    请输入序号：')).trim()
    const picked = options[Number(answer) - 1]

    if (picked) {
      return picked.value
    }

    console.log(red('    序号不在范围内，再试一次。'))
  }
}

/**
 * 装载签名密钥。
 *
 * 优先用已经存在的环境变量（CI 走的就是那条路），否则从用户目录读。密码缺失时
 * 问一次并存下来——因为那种「每次发版前先粘两条 PowerShell」的流程，迟早会在某个
 * 深夜被跳过，而跳过的结果是一个没有 .sig 的发布，静默地断掉整条更新通道。
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
    note(`已读取私钥 ${KEY_PATH}`)
  }

  if (process.env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] !== undefined) {
    return
  }

  const saved = await readFile(PASS_PATH, 'utf8').catch(() => null)

  if (saved !== null) {
    process.env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = saved.trim()
    note(`已读取私钥密码 ${PASS_PATH}`)
    return
  }

  console.log('')
  note('第一次运行，需要私钥密码。它会存进你的用户目录，以后不会再问。')

  const entered = (await rl.question('    私钥密码（没有密码就直接回车）：')).trim()

  await mkdir(path.dirname(PASS_PATH), { recursive: true })
  await writeFile(PASS_PATH, entered, 'utf8')
  process.env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = entered

  console.log(green(`    已记住，存在 ${PASS_PATH}`))
}

/* ── [1] 起飞前检查 ────────────────────────────────────────── */

async function preflight(): Promise<{ branch: string; current: string }> {
  step('起飞前检查：确认现在这台机器可以安全地发一个版本')

  const pkg = JSON.parse(await readFile('package.json', 'utf8').catch(() => 'null')) as {
    name?: string
  } | null

  if (pkg?.name !== 'poietica') {
    throw new Abort('请在仓库根目录运行这个脚本。')
  }

  /*
   * 当前版本从 Cargo workspace 读，不从 package.json 读。
   *
   * check-versions.mjs 认定的单一真相就在那里。上一版在这一步改读 package.json，
   * 等于给同一个数字留了两个源头：四处一旦漂移，发布会照着错的那个往上加。
   */
  const cargo = await readFile(CARGO, 'utf8')
  const current = cargo.split(/^\[workspace\.package\]$/m)[1]?.match(CARGO_VERSION)?.[1]

  if (!current) {
    throw new Abort(`读不到 ${CARGO} [workspace.package] 里的 version。`)
  }

  const branch = capture('git', 'rev-parse', '--abbrev-ref', 'HEAD')

  if (branch === null) {
    throw new Abort('git 不可用，或者这里不是一个 git 仓库。')
  }

  if (branch !== MAIN_BRANCH) {
    note(`当前分支是 ${branch}，不是 ${MAIN_BRANCH}`)

    if (!(await confirm('仍然从这个分支发布？', false))) {
      throw new Abort('已取消。')
    }
  }

  /* capture 失败也返回 null，和「干净」共用一个值会把执行失败误报成脏工作区。 */
  const dirty = capture('git', 'status', '--porcelain')

  if (dirty === null) {
    throw new Abort('git status 执行失败，无法确认工作区状态。')
  }

  if (dirty !== '') {
    throw new Abort('工作区有未提交的改动。发布必须来自一个确定的提交，请先提交或暂存。')
  }

  note('正在与远端对表…')
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
  console.log(green('    通过。'))

  return { branch, current }
}

/* ── [2] 选版本 ────────────────────────────────────────────── */

/**
 * 只从交互里拿版本号。
 *
 * 不提供命令行标志：这个脚本从起飞前检查到发布确认有七八处提问，本来就不可能
 * 非交互运行，标志省不掉任何一次输入，只会多出一条永远走不满的解析分支。
 * 要填任意版本号，选「手动输入」。
 */
async function pickVersion(current: string): Promise<{ target: string; tag: string }> {
  step('选版本：决定这次发布叫什么')
  note(`当前版本 ${current}`)

  const next = bumped(current)

  const picked = await choose('这次发布哪一个？', [
    { label: `修订版  ${next.patch}   （修 bug、小改动）`, value: next.patch },
    { label: `次版本  ${next.minor}   （加功能）`, value: next.minor },
    { label: `主版本  ${next.major}   （不兼容变更）`, value: next.major },
    { label: '手动输入', value: null },
  ])

  let target = picked

  /*
   * 手动输入写错就重问。走到这里可能已经花了十几分钟跑门禁，不该因为一个笔误退场。
   *
   * 例子从当前版本派生，而且刻意举一个预发布号：三个预设已经覆盖了 patch/minor/major，
   * 会走到这一支的场景本来就是预发布、跳号、hotfix 这些预设给不了的形态。
   */
  const example = `${next.patch}-beta.1`

  while (target === null || !SEMVER.test(target)) {
    if (target !== null) {
      console.log(red(`    不是合法的版本号：${target}`))
    }

    target = (await rl.question(`    输入版本号（如 ${example}）：`)).trim()
  }

  const tag = `v${target}`

  /* 本地 tag 与远端 tag 都要看：只删了本地那份，push 时照样会撞车。 */
  const localTag = capture('git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`)
  const remoteTag = capture('git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`)

  if (localTag !== null || (remoteTag !== null && remoteTag !== '')) {
    throw new Abort(
      [
        `tag ${tag} 已经存在（${localTag !== null ? '本地' : ''}${remoteTag ? ' 远端' : ''}）。`,
        '如果那次发布是失败的，先撤掉它：',
        `  gh release delete ${tag} --yes`,
        `  git push origin :refs/tags/${tag}`,
        `  git tag -d ${tag}`,
        '',
        '注意：已经发出去过的版本号不要复用。已经装上它的客户端不会再看到同号更新，',
        '会被永久留在旧代码上——改发下一个号。',
      ].join('\n'),
    )
  }

  console.log('')
  console.log(`    ${bold(current)} ${dim('→')} ${bold(green(target))}`)
  console.log('')

  if (!(await confirm('确认开始？'))) {
    throw new Abort('已取消。')
  }

  return { target, tag }
}

/* ── [3] 质量门禁（在写版本号之前）───────────────────────────── */

async function gate() {
  step('质量门禁：lint、类型、测试、clippy 全跑一遍')
  note('放在写版本号之前跑。门禁失败时仓库还没被动过，什么都不用回滚。')
  note('这一步比较慢。跳过它意味着你可能会把一个坏版本装到自己电脑上。')

  if (!(await confirm('现在跑完整门禁？（推荐）'))) {
    console.log(yellow('    已跳过门禁。'))
    return
  }

  run('bun', 'run', 'check')
  run('bun', 'run', 'ipc:check')
}

/* ── [4] 写版本号 ──────────────────────────────────────────── */

/*
 * 这里曾经跟着两条 biome format --write / biome ci。
 *
 * 那不是保险，是载荷：set-version.mjs 当时对三个 JSON 走的是 JSON.parse +
 * JSON.stringify，每次发版都会按 stringify 的口味重排文件，tauri.conf.json 里能
 * 塞进一行的短数组被撑成多行，发布提交一进 CI 就被 biome ci 判格式不对。
 * set-version.mjs 现在四个文件统一走逐字节替换，源头没了，兜底也就删了。
 */
function applyVersion(target: string): void {
  step('写版本号：把它同时写进 Cargo.toml 与三个 package/conf 文件')
  note('四处版本号不一致会让客户端陷入无限更新提示，所以写完立刻校验一遍。')

  run('bun', 'run', 'version:set', target)
  versionFilesDirty = true
  run('bun', 'run', 'check:versions')
}

function restoreVersionFiles(): void {
  if (!versionFilesDirty) {
    return
  }

  console.log('')
  console.log(yellow('    正在把版本号改动签回去，仓库回到发布前的状态。'))

  /* git 2.23 起，撤销工作区改动是 git restore 的职责，checkout 那条是历史包袱。 */
  tryRun('git', 'restore', '--', ...VERSION_FILES)
  versionFilesDirty = false
}

/* ── [5][6][7] 清空、构建、收集产物 ─────────────────────────── */

async function buildAndStage(
  target: string,
  tag: string,
): Promise<{ installer: string; assets: string[] }> {
  step('清空构建目录：删掉上一版残留的安装包')
  note('残留产物会让清单指向旧版本的安装包，签名照样能过，客户端会陷入更新死循环。')

  await rm(BUNDLE_DIR, { recursive: true, force: true })
  await rm(STAGE_DIR, { recursive: true, force: true })
  console.log(dim(`    已清空 ${BUNDLE_DIR} 与 ${STAGE_DIR}`))

  step('构建安装包：编译并用你的私钥签名（这一步最久，十几分钟起）')
  note('可以去干别的了，跑完会响一声。')

  run('bun', 'run', 'build:release')

  /* 十几分钟没人会一直盯着终端。跑完敲一下铃，把人叫回来做后面的确认。 */
  process.stdout.write('\u0007')

  step('收集产物：挑出这个版本的安装包、签名，生成更新清单与校验和')

  const files = await readdir(BUNDLE_DIR).catch((): string[] => [])
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

  const payload = `poietica-${target}.payload.zst`

  await stat(RELEASE_EXE).catch(() => {
    throw new Abort(`${RELEASE_EXE} 不在：更新载荷的基线必须是安装器真正装出去的那个可执行文件。`)
  })

  run('bun', 'tools/release/manifest.ts', RELEASE_EXE, STAGE_DIR, tag)

  /*
   * 四个资产全部入账，不只安装包。
   *
   * 只给 exe 出校验和，等于对 latest.json 和 .sig 说「你俩自己看着办」——而它们
   * 恰恰是整条更新通道的信任来源。成熟发行（rustup、Zed）给的都是整份清单。
   */
  const digests = new Map<string, string>()

  for (const name of (await readdir(STAGE_DIR)).sort()) {
    const bytes = await readFile(`${STAGE_DIR}/${name}`)
    digests.set(name, createHash('sha256').update(bytes).digest('hex'))
  }

  const sums = [...digests].map(([name, digest]) => `${digest}  ${name}`).join('\n')
  await writeFile(`${STAGE_DIR}/SHA256SUMS.txt`, `${sums}\n`, 'utf8')

  const manifest: { version?: string; full?: { url?: string } } = JSON.parse(
    await readFile(`${STAGE_DIR}/latest.json`, 'utf8'),
  )
  const size = (await stat(`${STAGE_DIR}/${installer}`)).size / 1024 / 1024

  console.log('')
  console.log(`    安装包   ${installer}`)
  console.log(`    体积     ${size.toFixed(1)} MB`)
  console.log(`    SHA256   ${(digests.get(installer) ?? '').slice(0, 16)}…`)
  console.log(`    校验和   ${digests.size} 个资产`)
  console.log(`    清单版本 ${manifest.version}`)
  console.log(`    指向     ${manifest.full?.url ?? '(missing)'}`)
  console.log('')

  if (manifest.version !== target) {
    throw new Abort(`清单里的版本是 ${manifest.version}，不是 ${target}。`)
  }

  if (!(manifest.full?.url ?? '').endsWith(payload)) {
    throw new Abort('清单指向的载荷和刚生成出来的这个对不上。')
  }

  note('下一步会推送 tag 并创建 release —— 这是最后一个能无痕退出的地方。')

  if (!(await confirm('以上信息正确，继续发布？'))) {
    throw new Abort('已取消。产物留在 dist-release，未推送任何东西。')
  }

  return { installer, assets: (await readdir(STAGE_DIR)).sort() }
}

/* ── [8][9][10] 提交打标、发布、验通道 ──────────────────────── */

async function publish({
  branch,
  tag,
  assets,
}: {
  branch: string
  tag: string
  assets: readonly string[]
}): Promise<void> {
  const state = { committed: false, tagPushed: false }

  try {
    step('提交并打标：把版本号改动推上去，附带这次的 tag')

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

    step('发布：上传安装包、签名、清单、校验和到 GitHub Release')

    run(
      'gh',
      'release',
      'create',
      tag,
      ...assets.map((name) => `${STAGE_DIR}/${name}`),
      '--title',
      tag,
      '--generate-notes',
      '--latest',
    )

    step('验证更新通道：用客户端真正会去访问的那条地址，确认它现在返回新版本')
    note('资产没传上、release 不是 latest、版本对不上——这三种失败都是静默的，只能这样验。')

    run('bun', 'tools/release/verify-channel.ts', tag)
  } catch (error) {
    await unwind({
      branch,
      tag,
      state,
      error: error instanceof Error ? error : new Error(String(error)),
    })
    throw new Abort('发布未完成。')
  }
}

/**
 * 把已经推出去的半个发布收回来。
 *
 * 顺序是从外往里：release → 远端 tag → 本地 tag → 版本号提交。最后那一步分两种情况，
 * 因为推没推出去决定了能不能直接把提交抹掉。
 */
async function unwind({
  branch,
  tag,
  state,
  error,
}: {
  branch: string
  tag: string
  state: { committed: boolean; tagPushed: boolean }
  error: Error
}): Promise<void> {
  console.log('')
  console.log(red(`发布中断：${error.message}`))
  console.log('')

  if (!(await confirm('要撤回这次发布吗？（删除 release、tag，并回退版本号提交）', true))) {
    console.log(yellow(`已保留现场。tag ${tag} 与版本号提交仍在。`))
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
    console.log(yellow(`已撤回 ${tag}，并推送了一个 revert 提交。`))
    return
  }

  /* 还没推出去：直接把这个本地提交抹掉，版本号回到发布前。 */
  tryRun('git', 'reset', '--hard', 'HEAD~1')
  console.log(yellow(`已撤回 ${tag}，版本号提交已丢弃，仓库回到发布前的状态。`))
}

/* ── 中断处理 ──────────────────────────────────────────────── */

/*
 * Ctrl+C 也要走回滚。
 *
 * 构建那一步十几分钟，中途改主意按下 Ctrl+C 是很自然的动作。没有这个 handler 的话，
 * 版本号已经写进四个文件、进程直接消失，留下的正是我们花力气避免的那种脏状态。
 */
function onInterrupt(): void {
  console.log('')
  console.log(yellow('已中断。'))
  restoreVersionFiles()
  rl.close()
  process.exit(130)
}

rl.on('SIGINT', onInterrupt)
process.on('SIGINT', onInterrupt)

/* ── 编排 ──────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log(bold('\nPoietica 发布流程 · 本地构建 + gh 发布\n'))

  const { branch, current } = await preflight()
  const { target, tag } = await pickVersion(current)

  await gate()

  try {
    applyVersion(target)
    const staged = await buildAndStage(target, tag)
    await publish({ branch, tag, assets: staged.assets })
  } catch (error) {
    restoreVersionFiles()
    throw error
  }

  console.log(dim(`    ✓ 用时 ${elapsed(stepStartedAt)}`))
  console.log('')
  console.log(green(bold(`  ${tag} 发布完成，全程 ${elapsed(startedAt)}。`)))

  const releaseUrl = capture('gh', 'release', 'view', tag, '--json', 'url', '-q', '.url')

  if (releaseUrl !== null) {
    console.log(dim(`  ${releaseUrl}`))
  }

  console.log('')
  console.log('  还剩下机器做不了的那一步：')
  console.log('    1. 打开已经装着旧版本的 Poietica')
  console.log('    2. 等左下角问号左边出现更新胶囊（启动后 30 秒内）')
  console.log('    3. 点它，看进度填满，再点重启')
  console.log(`    4. 重启后确认版本号已经是 ${target}`)
  console.log('')
}

main()
  .then(() => {
    rl.close()
  })
  .catch((error) => {
    rl.close()
    console.error('')
    console.error(red(error instanceof Abort ? error.message : String(error?.stack ?? error)))
    console.error('')
    process.exit(1)
  })
