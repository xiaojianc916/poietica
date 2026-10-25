import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/*
 * 代码审查页的真机冒烟：`bun run check:review-page`
 * 三栏的几件事（谁的滚动条在滚、右栏有没有被挤掉、标题有没有被截断、检查项的颜色有没有落地）
 * 在 happy-dom 里量不出来 —— 那里没有布局。用真实 Electron、真实组件、真 GitHub 数据渲染一遍，
 * 量到的几何与截图交回人看。退出码：0 全过 / 1 有不合格 / 2 环境不合格（没 gh / 没登录 / 没 electron）。
 */

/* 本文件在 tooling/checks/review-page/ 下：回三层才是仓库根。 */
const ROOT = path.resolve(import.meta.dir, '../../..')

interface RawNode {
  readonly number: number
  readonly title: string
  readonly state?: string
  readonly isDraft?: boolean
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly mergedAt?: string | null
  readonly mergeable?: string | null
  readonly mergeStateStatus?: string | null
  readonly additions?: number
  readonly deletions?: number
  readonly changedFiles?: number
  readonly headRefName?: string
  readonly baseRefName?: string
  readonly url?: string
  readonly body?: string
  readonly author?: { readonly login?: string; readonly avatarUrl?: string | null } | null
  readonly reviewDecision?: string | null
  readonly comments?: { readonly totalCount?: number }
  readonly reviews?: { readonly totalCount?: number }
  readonly commits?: { readonly totalCount?: number }
  readonly labels?: { readonly nodes?: readonly { readonly name?: string }[] }
  readonly statusCheckRollup?: {
    readonly contexts?: {
      readonly nodes?: readonly {
        readonly __typename?: string
        readonly name?: string | null
        readonly conclusion?: string | null
        readonly context?: string | null
        readonly state?: string | null
      }[]
    }
  } | null
}

/* 只够冒烟用的一份最小映射：真映射在 core/pr.ts，由 core 的单测守着（判据不在这里重复）。 */
function checkStateOf(entry: { readonly conclusion?: string | null; readonly state?: string | null }): string {
  const value = entry.conclusion ?? entry.state ?? ''
  if (value === 'SUCCESS') return 'success'
  if (value === 'FAILURE' || value === 'ERROR' || value === 'TIMED_OUT' || value === 'CANCELLED') return 'failure'
  if (value === 'SKIPPED') return 'skipped'
  if (value === 'NEUTRAL') return 'neutral'
  return 'pending'
}

function mergeStatusOf(node: RawNode): string {
  if (node.isDraft === true) return 'draft'
  if (node.mergeable === 'CONFLICTING' || node.mergeStateStatus === 'DIRTY') return 'conflicting'
  if (node.mergeStateStatus === 'BLOCKED') return 'blocked'
  if (node.mergeStateStatus === 'BEHIND') return 'behind'
  if (node.mergeStateStatus === 'CLEAN' || node.mergeable === 'MERGEABLE') return 'clean'
  return 'unknown'
}

function pullStateOf(state: string | undefined): string {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return 'open'
}

function reviewStateOf(decision: string | null | undefined): string {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes_requested'
  if (decision === 'REVIEW_REQUIRED') return 'review_required'
  return 'none'
}

/* 计数字段：GitHub 偶尔漏某个 totalCount，缺了就报 0，别让冒烟读不出数据。 */
function countsOf(node: RawNode): Record<string, number> {
  return {
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    commits: node.commits?.totalCount ?? 0,
    comments: node.comments?.totalCount ?? 0,
    reviews: node.reviews?.totalCount ?? 0,
  }
}

function labelsOf(node: RawNode): readonly string[] {
  return (node.labels?.nodes ?? []).flatMap((label) =>
    label.name === undefined || label.name === '' ? [] : [label.name],
  )
}

function mapPull(node: RawNode): Record<string, unknown> {
  const checks = (node.statusCheckRollup?.contexts?.nodes ?? []).map((entry) => ({
    name: entry.name ?? entry.context ?? 'check',
    state: checkStateOf(entry),
  }))
  return {
    number: node.number,
    title: node.title,
    state: pullStateOf(node.state),
    draft: node.isDraft === true,
    author: node.author?.login ?? 'ghost',
    avatarUrl: node.author?.avatarUrl ?? null,
    createdAt: node.createdAt ?? '',
    updatedAt: node.updatedAt ?? '',
    mergedAt: node.mergedAt ?? null,
    headBranch: node.headRefName ?? '',
    baseBranch: node.baseRefName ?? '',
    ...countsOf(node),
    mergeStatus: mergeStatusOf(node),
    reviewState: reviewStateOf(node.reviewDecision),
    url: node.url ?? '',
    body: node.body ?? '',
    labels: [...labelsOf(node)],
    checks,
  }
}

/* 与 core/pr.ts 的 ONE_QUERY 同形，但只取列表里最上面那一条 —— 冒烟要的是「一条真数据」。 */
const PULL_FIELDS_QUERY = `query($owner: String!, $name: String!, $states: [PullRequestState!]) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 5, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title state isDraft createdAt updatedAt mergedAt
        mergeable mergeStateStatus additions deletions changedFiles
        headRefName baseRefName url body
        author { login avatarUrl }
        reviewDecision
        comments { totalCount } reviews { totalCount } commits { totalCount }
        labels(first: 20) { nodes { name } }
        statusCheckRollup { contexts(first: 50) { nodes {
          __typename
          ... on CheckRun { name conclusion status }
          ... on StatusContext { context state }
        } } }
      }
    }
  }
}`
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(import.meta.dir, 'main.cjs')
const OUT = path.join(ROOT, '.review-page-shots')

interface Finding {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

interface Metrics {
  readonly checkGlyphs?: readonly {
    readonly name: string
    readonly discBg: string | null
    readonly discRadius: string | null
    readonly discSize: string | null
    readonly innerColor: string | null
    readonly innerStroke: string | null
  }[]
}

/* 功能自己的四份 CSS：它们不在渲染层入口里（那是外壳的入口），单独拼进来。 */
async function componentCss(): Promise<string> {
  const files = ['pr-page.css', 'pr-sidebar.css', 'pr-detail.css', 'pr-info.css']
  const fs = await import('node:fs/promises')
  const parts = await Promise.all(
    files.map((name) => fs.readFile(path.join(ROOT, 'features', 'review', 'src', 'ui', name), 'utf8')),
  )
  return parts.join('\n')
}

/*
 * 样式必须真的过一遍 Tailwind —— Bun.build 不认识 @import "tailwindcss"，也不做 @source
 * 扫描，产物里一个工具类都没有，量出来的版面全是假的。编译步骤住在 apps/desktop/scripts
 * （@tailwindcss/node 只装在那里），这里以子进程调它。
 */
function buildCss(outFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['run', path.join(ROOT, 'apps', 'desktop', 'scripts', 'compile-styles.ts'), outFile],
      { cwd: ROOT, env: { ...process.env } },
    )
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(outFile)
      else reject(new Error(`Tailwind 编译失败（退出码 ${String(code)}）：${err}`))
    })
  })
}

async function buildPage(fixture: unknown): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-review-'))
  const built = await Bun.build({
    /* harness 住在功能包里：它 import 的是功能的源码与 ui-kernel，只有在那里才解析得到。 */
    entrypoints: [path.join(ROOT, 'features', 'review', 'scripts', 'harness.tsx')],
    target: 'browser',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  if (!built.success) {
    for (const log of built.logs) console.error(log.message)
    process.exit(2)
  }
  const js = built.outputs.find((output) => output.path.endsWith('.js'))
  if (js === undefined) {
    console.error('[review-page] 打包产物里没有 js')
    process.exit(2)
  }
  const cssFile = path.join(dir, 'styles.css')
  await buildCss(cssFile)
  const fs = await import('node:fs/promises')
  const cssParts = [await fs.readFile(cssFile, 'utf8'), await componentCss()]
  const css = { text: async () => cssParts.join('\n') }
  const html = `<!doctype html>
<html data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; background: #ffffff; }
      ${css === undefined ? '' : await css.text()}
    </style>
  </head>
  <body style="height:100%">
    <div id="root" style="height:100%"></div>
    <script type="module">
      window.__prFixture = ${JSON.stringify(fixture)}
      import('./harness.js')
    </script>
  </body>
</html>`
  writeFileSync(path.join(dir, 'harness.js'), await js.text())
  writeFileSync(path.join(dir, 'index.html'), html)
  return path.join(dir, 'index.html')
}

function render(html: string): Promise<{ report?: readonly Finding[]; metrics?: Metrics }> {
  return new Promise((resolve, reject) => {
    /*
     * 必须显式清掉 ELECTRON_RUN_AS_NODE：宿主的 shell 里可能带着它（那是「把 electron 当 node 用」
     * 的开关），带着它启动就没有 app / BrowserWindow，只会得到一句 "Cannot read properties of
     * undefined"。真实 Electron 应用的窗口进程不带这个变量。
     */
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(ELECTRON, [MAIN, html, OUT], { cwd: ROOT, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('{'))
      if (line === undefined) {
        reject(new Error(`electron 退出码 ${String(code)}\n${stderr}`))
        return
      }
      resolve(JSON.parse(line) as { report?: readonly Finding[]; metrics?: Metrics })
    })
  })
}

/* 冒烟只跟 gh 打交道：tooling 不能 import 功能源码（isolated linker），所以数据在应用侧读好、
   这里只把「读到的真数据」搬进渲染器。映射逻辑由 core 的单测守着，不在这里重复一份。 */
function gh(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', [...args], { cwd, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`gh ${args.join(' ')} 退出码 ${String(code)}：${err.trim()}`))
    })
  })
}

const cwd = process.cwd()
let login = ''
try {
  login = (await gh(['api', 'user', '--jq', '.login'])).trim()
  if (login === '') throw new Error('空账号名')
} catch (cause) {
  console.error(`[review-page] 环境不合格：gh 不可用或没登录（${String(cause)}）`)
  process.exit(2)
}

let view: { nameWithOwner: string; url: string }
try {
  view = JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner,url'], cwd)) as typeof view
} catch (cause) {
  console.error(`[review-page] 环境不合格：当前目录的远端不在 GitHub 上（${String(cause)}）`)
  process.exit(2)
}
const [owner = '', name = ''] = view.nameWithOwner.split('/')
const repository = { owner, name, fullName: view.nameWithOwner, url: view.url }

const raw = await gh(
  [
    'api',
    'graphql',
    '-f',
    `query=${PULL_FIELDS_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-f',
    'states[]=OPEN',
  ],
  cwd,
)
const parsed = JSON.parse(raw) as { data?: { repository?: { pullRequests?: { nodes?: readonly RawNode[] } } } }
const node = parsed.data?.repository?.pullRequests?.nodes?.[0]
if (node === undefined) {
  console.error('[review-page] 这个仓库在 GitHub 上没有开着的 pull request，冒烟无从谈起')
  process.exit(2)
}
const detailed = mapPull(node)
console.log(
  `[review-page] 用真数据渲染：${repository.fullName}#${String(detailed.number)} ${detailed.mergeStatus} +${String(detailed.additions)} −${String(detailed.deletions)}`,
)

const html = await buildPage({ pull: detailed, repository, login })
const result = await render(html)

if (result.report === undefined) {
  console.error('[review-page] 渲染没有交回几何')
  process.exit(1)
}

/* 字形形状靠人眼与数值一起看：先把量到的颜色打出来。 */
if (result.metrics !== undefined) {
  console.log('[review-page] 检查项字形:', JSON.stringify(result.metrics.checkGlyphs, null, 1))
}

let bad = 0
for (const finding of result.report) {
  console.log(`${finding.ok ? '✔' : '✘'} ${finding.name}：${finding.detail}`)
  if (!finding.ok) bad += 1
}
console.log(`[review-page] 截图在 ${OUT}`)
process.exit(bad === 0 ? 0 : 1)
