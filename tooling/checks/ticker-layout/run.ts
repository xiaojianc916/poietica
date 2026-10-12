import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  computeMetrics,
  DEFAULT_THRESHOLDS,
  FAST_THRESHOLDS,
  judge,
  type Metrics,
  REDUCED_THRESHOLDS,
  type Sample,
  type Thresholds,
} from './metrics'
import { SCENARIO_IDS, STREAMS, type Stream } from './streams'

/*
 * 思考行的真实布局检查（§8.4，规格 C7）。
 *
 *   bun run check:ticker
 *
 * 它要真实的 GPU 与窗口，所以**不**放进 `bun run all`。改 timeline/rolling-line*、
 * ticker-*、roll-scheduler*、flow-row.css 时必须跑一次 —— 那几条要钉的性质（最新的字有没有
 * 被裁、放得下时句首有没有被吃）在 happy-dom 里量不出来，而 v1 就栽在这一条上。
 *
 * 流程：Bun.build 把 harness 打成一个 html → electron 逐场景跑、逐帧采样、存三张截图 →
 * 这里用纯函数算指标、比阈值。退出码 0 全过 / 1 有不合格 / 2 环境不合格。
 *
 * 调参时可以只跑一个场景：`bun run check:ticker <id>`（不带参数就是全跑）。
 */

const ROOT = path.resolve(import.meta.dir, '../../..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(import.meta.dir, 'main.cjs')

interface ScenarioResult {
  readonly id: string
  readonly fps: number
  readonly skipped?: boolean
  readonly samples?: readonly Sample[]
  readonly arrivals?: readonly { readonly at: number; readonly length: number }[]
}

function thresholdsFor(stream: Stream): Thresholds {
  if (stream.reduced) return REDUCED_THRESHOLDS
  if (stream.id === 'fast') return FAST_THRESHOLDS

  return DEFAULT_THRESHOLDS
}

/** 把 harness 打成一个 html（含样式），放进一个临时目录。 */
async function buildPage(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-ticker-'))
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, 'harness.tsx')],
    target: 'browser',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })

  if (!built.success) {
    for (const log of built.logs) console.error(log.message)
    process.exit(1)
  }

  const js = built.outputs.find((output) => output.path.endsWith('.js'))
  const css = built.outputs.find((output) => output.path.endsWith('.css'))

  if (js === undefined) {
    console.error('[ticker-layout] 打包产物里没有 js')
    process.exit(1)
  }

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; background: #ffffff; }
      body { width: 760px; }
      ${css === undefined ? '' : await css.text()}
    </style>
  </head>
  <body data-assistant-skin>
    <div id="root"></div>
    <script type="module">
      import { mountHarness } from './harness.js'
      mountHarness()
    </script>
  </body>
</html>`

  writeFileSync(path.join(dir, 'harness.js'), await js.text())
  writeFileSync(path.join(dir, 'index.html'), html)

  return path.join(dir, 'index.html')
}

/** 跑一个场景（一个 electron 进程），把那一行 JSON 收回来。 */
function runScenario(html: string, stream: Stream, outDir: string): Promise<ScenarioResult> {
  const scenario = {
    id: stream.id,
    arrivals: stream.arrivals,
    resize: stream.resize,
    reduced: stream.reduced,
  }

  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [MAIN, html, JSON.stringify(scenario), outDir], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    })
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

      resolve(JSON.parse(line) as ScenarioResult)
    })
  })
}

function report(id: string, metrics: Metrics, failures: readonly string[], fps: number, thresholds: Thresholds): void {
  const latency = `${String(metrics.p50)} / ${String(metrics.p95)} / ${String(metrics.max)}`
  const line =
    `${id.padEnd(8)} fps ${fps.toFixed(0)}  右裁 ${String(metrics.rightClip)}  句首被裁 ${String(metrics.leftCutWhileFits)}` +
    `  延迟 p50/p95/max ${latency}ms  应动未动 ${(metrics.stallFrac * 100).toFixed(0)}%  sJ90 ${metrics.sJ90.toFixed(2)}`

  console.log(failures.length === 0 ? `✔ ${line}` : `✘ ${line}`)

  /* 没有阈值的项只报数：极快档的顿挫是 §10 记下的已知局限，不是这一版要修的缺陷。 */
  if (thresholds.stallFrac === null) console.log('   - 应动未动与 sJ90 只记录、不判定（极快 / 少动效档，见 §10）')

  for (const failure of failures) console.log(`   - ${failure}`)
}

const outDir = path.join(ROOT, '.ticker-layout')
const only = process.argv[2]

/* 场景名写错时不许「一场没跑」地绿着退出：那种检查看着过，其实什么都没查。 */
if (only !== undefined && !STREAMS.some((stream) => stream.id === only)) {
  console.error(`[ticker-layout] 没有这个场景：${only}（可用的：${SCENARIO_IDS.join(' / ')}）`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

const html = await buildPage()
let failed = false
let skipped = false

/* 顺序跑：同时开几个窗口会让帧率互相影响，测出来的抖动没有意义。 */
for (const stream of STREAMS.filter((candidate) => only === undefined || candidate.id === only)) {
  const result = await runScenario(html, stream, outDir)

  if (result.skipped === true) {
    console.log(`⚠ ${stream.id.padEnd(8)} 环境不合格：帧率 ${result.fps.toFixed(1)}fps < 50fps，不给结论`)
    skipped = true
    continue
  }

  const metrics = computeMetrics(result.samples ?? [], result.arrivals ?? [])
  const thresholds = thresholdsFor(stream)
  const failures = judge(metrics, thresholds)

  /* 原始采样留档：指标坏了要能回看是采样的问题还是判定的问题。 */
  writeFileSync(
    path.join(outDir, `${stream.id}.json`),
    JSON.stringify({ fps: result.fps, metrics, samples: result.samples, arrivals: result.arrivals }),
  )

  report(stream.id, metrics, failures, result.fps, thresholds)
  if (failures.length > 0) failed = true
}

console.log(`\n截图在 ${path.relative(ROOT, outDir)}/`)

process.exit(skipped ? 2 : failed ? 1 : 0)
