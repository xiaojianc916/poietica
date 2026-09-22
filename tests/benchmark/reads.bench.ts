import { writeFileSync } from 'node:fs'
import type {
  AgentSessionPort,
  TranscriptPage,
  TranscriptPort,
  TranscriptSignal,
} from '@poietica/conversation'
import { selectPresentation, TranscriptStore } from '@poietica/conversation'
import { fixture, pageOf } from './fixture.ts'

/*
 * 打开一条对话：server 的整份正文被要了几次。
 *
 * 这是"打开超大对话"里唯一随正文大小线性放大、又不是 CPU 的那一项：一次全文往返
 * 在本机实测 6–10 ms（tmp/perf/server-latency.mjs），而冷会话的正文是 server 从
 * wire records 现场重建的，几十万字节。多要一次就多花一次。
 *
 * 时序照抄本机 kimi web 0.29.x 的实测（tmp/perf/ws-watch.mjs、ws-order.mjs、ws-body.mjs）：
 *
 *   冷会话 —— 本机 180 条对话里 178 条是这个形状：
 *     订阅只回 ack，没有任何 transcript 帧（server 不为冷会话整发）
 *     GET /transcript       正文，没有 seq
 *     GET /transcript/ops   complete:false, latest_seq:0, batches:[]
 *   在跑的会话（本机只有 2 条）：
 *     订阅回每一条 agent 的 transcript.reset（items:[], has_more_older:true, seq:1）
 *     GET /transcript       正文，seq=1
 *     GET /transcript/ops   complete:true, latest_seq:1
 *
 * reset 在 Rust 的 activate 里订阅（subscribe_transcript），早于 open_thread 读正文，
 * 所以它在 route 之前抵达 TS。
 *
 * 用法：bun run benchmark/reads.bench.ts [输出.json]
 */

const PAYLOAD = fixture('real-conversation')
const RAW = PAYLOAD.json
const PAGE = PAYLOAD.bytes

interface Counted {
  /** 整份正文被要了几次：open 那一份 + readTranscript 那几份。 */
  full: number
  refetched: number
  catches: number
  bytes: number
}

interface Scenario {
  readonly name: string
  readonly live: boolean
  readonly reset: 'before' | 'never'
}

async function openOnce(scenario: Scenario): Promise<Counted> {
  const counted: Counted = { full: 1, refetched: 0, catches: 0, bytes: PAGE }
  const decoded = pageOf(RAW)
  const baseline: TranscriptPage = scenario.live
    ? { ...decoded, seq: 1 }
    : (decoded as TranscriptPage)

  let listener: ((signal: TranscriptSignal) => void) | undefined
  const port = {
    subscribeTranscript: (next: (signal: TranscriptSignal) => void) => {
      listener = next
      return () => undefined
    },
    readTranscript: async (): Promise<TranscriptPage> => {
      counted.full += 1
      counted.refetched += 1
      counted.bytes += PAGE
      return baseline
    },
    catchUpTranscript: async (_session: string, agentId: string) => {
      counted.catches += 1
      return scenario.live
        ? { agentId, batches: [], latestSeq: 1, complete: true }
        : { agentId, batches: [], latestSeq: 0, complete: false }
    },
    readMedia: async () => ({ mediaType: 'image/png', base64: '' }),
  } as unknown as TranscriptPort

  const store = new TranscriptStore()
  store.ensure({ transcript: port } as unknown as AgentSessionPort)

  if (scenario.live && scenario.reset === 'before') {
    listener?.({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: 1 })
  }
  store.route('session', 'thread', baseline)

  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  selectPresentation(store.read('thread').timeline, new Map())
  store.dispose()
  return counted
}

const SCENARIOS: readonly Scenario[] = [
  { name: '冷会话 · reset 缺席（178/180）', live: false, reset: 'never' },
  { name: '在跑的会话 · reset 先到', live: true, reset: 'before' },
]

const report: Record<string, Counted> = {}
console.log(`载荷 ${String(Math.round(PAGE / 1024))} KB\n`)
console.log('场景                              整份正文  重新取回  catch-up     字节')
for (const scenario of SCENARIOS) {
  let last: Counted | undefined
  for (let index = 0; index < 6; index += 1) {
    last = await openOnce(scenario)
  }
  if (last === undefined) {
    throw new Error('the scenario produced no run.')
  }
  report[scenario.name] = last
  console.log(
    `${scenario.name.padEnd(32)} ${String(last.full).padStart(8)} ${String(last.refetched).padStart(10)} ` +
      `${String(last.catches).padStart(9)} ${String(Math.round(last.bytes / 1024)).padStart(8)} KB`,
  )
}

/*
 * 每一趟多出来的正文，TS 这一侧要付多少：一次 JSON.parse 加一次 zod 校验。
 * Rust 那两次转换（HTTP 应答 -> Value、Value -> IPC 文本）不在这个进程里，
 * 实测各约 1.5 ms / 1.4 ms（632 KB，见提交说明），所以下面报的是下限。
 */
const warmups = 5
const runs = 25
const decodeSamples: number[] = []
for (let run = 0; run < warmups + runs; run += 1) {
  const started = performance.now()
  pageOf(RAW)
  const elapsed = performance.now() - started
  if (run >= warmups) {
    decodeSamples.push(elapsed)
  }
}
decodeSamples.sort((a, b) => a - b)
const decodeCost =
  Math.round((decodeSamples[Math.floor(decodeSamples.length / 2)] ?? 0) * 1000) / 1000

console.log('')
console.log(
  `省下的每一趟正文，本进程还要再解一次：${String(decodeCost)} ms/趟（JSON.parse + zod 校验，` +
    `${String(Math.round(PAGE / 1024))} KB）；Rust 侧同一次往返另约 2.9 ms。`,
)

const destination = process.argv[2]
if (destination !== undefined) {
  writeFileSync(
    destination,
    `${JSON.stringify(
      { fixtureBytes: PAGE, scenarios: report, decodeCostPerRoundTripMs: decodeCost },
      null,
      2,
    )}\n`,
  )
  console.log(`\n写入 ${destination}`)
}
