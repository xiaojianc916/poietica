import { writeFileSync } from 'node:fs'
import { projectTranscript, selectPresentation } from '@poietica/conversation'
import { TranscriptStore as OfficialTranscriptStore } from '@poietica/transcript'
import { fixture, pageOf, scaled, snapshotOf } from './fixture.ts'

/*
 * "打开一条超大对话"的性能闸门：一条命令，四段量到底。
 *
 *   ① 解码   server 的 JSON 文本 -> TranscriptPage（zod 校验，唯一一处边界）
 *   ② 装入   官方 reducer 的 reset
 *   ③ 投影   snapshot -> TimelineState
 *   ④ 成帧   TimelineState -> Presentation，并把每一行问一遍
 *
 * 这四段全在一个同步任务里，就是"点开对话"那一帧要交的账。网络与 IPC 不在其中
 * （它们随机器与链路变，不随代码变）；"整份正文被要了几次"归 reads.bench.ts ——
 * 那一项随正文大小线性放大，且它不是 CPU。
 *
 * 用法：bun run benchmark/open-conversation.bench.ts [输出.json]
 */

const WARMUPS = 3
const RUNS = 15

const r3 = (value: number): number => Math.round(value * 1000) / 1000

interface Sample {
  readonly decode: number
  readonly install: number
  readonly project: number
  readonly present: number
  readonly total: number
  readonly rows: number
}

function medianOf(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return r3(sorted[Math.floor(sorted.length / 2)] ?? 0)
}

function once(json: string): Sample {
  const started = performance.now()

  const page = pageOf(json)
  const afterDecode = performance.now()

  const store = new OfficialTranscriptStore('bench')
  store.ensureAgent('main').receive([{ op: 'reset', agentId: 'main', snapshot: snapshotOf(page) }])
  const afterInstall = performance.now()

  const timeline = projectTranscript(store.ensureAgent('main').snapshot())
  const afterProject = performance.now()

  /* 屏幕按下标问的每一个问题都问一遍：成帧的成本就在这里。 */
  const presentation = selectPresentation(timeline, new Map())
  let rows = 0
  for (let index = 0; index < presentation.count; index += 1) {
    if (presentation.rowAt(index) !== undefined) {
      rows += 1
    }
    presentation.groupAt(index)
    presentation.sealAt(index)
    presentation.replyAt(index)
    presentation.turnIdAt(index)
  }
  const afterPresent = performance.now()

  return {
    decode: r3(afterDecode - started),
    install: r3(afterInstall - afterDecode),
    project: r3(afterProject - afterInstall),
    present: r3(afterPresent - afterProject),
    total: r3(afterPresent - started),
    rows,
  }
}

function stageOne(json: string): Record<keyof Sample, number> {
  const samples: Sample[] = []
  for (let run = 0; run < WARMUPS + RUNS; run += 1) {
    const sample = once(json)
    if (run >= WARMUPS) {
      samples.push(sample)
    }
  }
  const pick = (key: keyof Sample): number => medianOf(samples.map((sample) => sample[key]))
  return {
    decode: pick('decode'),
    install: pick('install'),
    project: pick('project'),
    present: pick('present'),
    total: pick('total'),
    rows: pick('rows'),
  }
}

/*
 * 与 reads.bench.ts 同一批场景：解码那一段要拿到"真实正文"才有意义，所以这里
 * 沿用同一份尺寸阶梯。
 */
const SCALES = [1, 8, 32, 128]

interface ScaleRow {
  readonly copies: number
  readonly turns: number
  readonly frames: number
  readonly kb: number
  readonly stages: Record<keyof Sample, number>
  readonly mbPerSecond: number
}

const rows: ScaleRow[] = []
for (const copies of SCALES) {
  const source =
    copies === 1 ? fixture('real-conversation') : scaled(fixture('real-conversation'), copies)
  const stages = stageOne(source.json)
  rows.push({
    copies,
    turns: source.turns,
    frames: source.frames,
    kb: Math.round(source.bytes / 1024),
    stages,
    mbPerSecond: r3(source.bytes / 1024 / 1024 / (stages.total / 1000)),
  })
}

const report = {
  generatedAt: new Date().toISOString(),
  fixtureBytes: fixture('real-conversation').bytes,
  stages: rows,
}

console.log(
  '规模            turn   frame       KB    解码    装入    投影    成帧     合计    吞吐',
)
for (const row of rows) {
  console.log(
    `×${String(row.copies).padEnd(4)} ${String(row.turns).padStart(7)} ${String(row.frames).padStart(7)} ` +
      `${String(row.kb).padStart(8)} ${String(row.stages.decode).padStart(7)} ` +
      `${String(row.stages.install).padStart(7)} ${String(row.stages.project).padStart(7)} ` +
      `${String(row.stages.present).padStart(7)} ${String(row.stages.total).padStart(8)} ` +
      `${String(row.mbPerSecond).padStart(7)} MB/s`,
  )
}
console.log('（单位 ms，中位数）')

const destination = process.argv[2]
if (destination !== undefined) {
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n写入 ${destination}`)
}
