/*
 * 桥这一侧屏幕经过的镜像：推出去什么，这里就落什么；读的时候从它答。
 *
 * 自检跑法：bun test src/__tests__/transcript-mirror.test.ts
 */

import { expect, test } from 'bun:test'
import {
  type TranscriptOperation,
  transcriptOpsPayloadSchema,
  transcriptResponseSchema,
} from '@poietica/transcript'
import { TranscriptMirror } from '../transcript-mirror.ts'

const TURN = [
  {
    op: 'turn.upsert' as const,
    turn: {
      kind: 'turn' as const,
      turnId: 't1',
      ordinal: 1,
      state: 'running' as const,
      origin: { kind: 'user' as const },
      prompt: 'hi',
    },
  },
]

/** 一条可指定正文长度的轮，用来把批次顶过注入的小预算。 */
function turnOf(turnId: string, ordinal: number, text: string): TranscriptOperation[] {
  return [
    {
      op: 'turn.upsert' as const,
      turn: {
        kind: 'turn' as const,
        turnId,
        ordinal,
        state: 'running' as const,
        origin: { kind: 'user' as const },
        prompt: text,
      },
    },
  ]
}

/** 一条可指定正文长度的文本帧 op，用来造出「单条 op 就很大」的情形。 */
function textOp(text: string): TranscriptOperation {
  return {
    op: 'frame.upsert' as const,
    turnId: 't1',
    stepId: 't1.0',
    frame: {
      kind: 'text' as const,
      frameId: 't1.0.f0',
      role: 'assistant' as const,
      text,
    },
  }
}

/*
 * 判据照抄读者：native-bridge 的 decodeTranscriptEvent 要求顶层同时有 `type` 与
 * `payload`，再用 transcriptOpsPayloadSchema 校验 payload。断言直接打在同一个
 * 两步上 —— 只测我们自己那半边的形状，是上一版漏掉 `seq` 还能全绿的原因。
 */
function decode(pushed: unknown): { seq?: number | undefined; ops: readonly unknown[] } {
  const envelope = pushed as { type?: unknown; payload?: unknown }
  expect(envelope.type).toBe('transcript.ops')

  return transcriptOpsPayloadSchema.parse(envelope.payload)
}

/** 一批推出去的行：`accept` 现在按字节预算切成若干条。 */
function push(mirror: TranscriptMirror, ops: readonly TranscriptOperation[]): unknown[] {
  return mirror.accept(ops)
}

function only(envelopes: readonly unknown[]): unknown {
  expect(envelopes).toHaveLength(1)

  return envelopes[0]
}

test('a pushed batch is the envelope the client decodes, and it carries a watermark', () => {
  const mirror = new TranscriptMirror('session')

  expect(decode(only(push(mirror, TURN))).seq).toBe(1)
  expect(decode(only(push(mirror, TURN))).seq).toBe(2)
})

test('the baseline page is a real page the client can seed from', () => {
  const mirror = new TranscriptMirror('session')
  push(mirror, TURN)

  const page = transcriptResponseSchema.parse(mirror.page('main'))

  expect(page.items).toHaveLength(1)
  expect(page.seq).toBe(1)
  // 手上就是这条会话的全部 ops，没有更早的一页可翻。
  expect(page.has_more).toBe(false)
})

test('catch-up returns only what is missing, and stays replayable from zero', () => {
  const mirror = new TranscriptMirror('session')
  push(mirror, TURN)
  push(mirror, TURN)

  const behind = mirror.catchUp('main', 1) as { batches: unknown[]; latest_seq: number }
  expect(behind.batches).toHaveLength(1)
  expect(behind.latest_seq).toBe(2)

  const cold = mirror.catchUp('main', 0) as { batches: unknown[]; latest_seq: number }
  expect(cold.batches).toHaveLength(2)
  expect(cold.latest_seq).toBe(2)

  const current = mirror.catchUp('main', 2) as { batches: unknown[] }
  expect(current.batches).toHaveLength(0)
})

test('an untouched session still answers with a valid empty page', () => {
  const page = transcriptResponseSchema.parse(new TranscriptMirror('session').page('main'))

  expect(page.items).toEqual([])
  expect(page.seq).toBe(0)
})

/*
 * 顶穿单行上限就是这次要修的缺陷：Rust 侧超一行不是丢帧，是整条连接当场拆掉，
 * 屏幕上是「agent 已经退出，请重新发起对话」。判据是**字节**，一个汉字三字节。
 */
test('a batch larger than the frame budget is split into several pushable lines', () => {
  const mirror = new TranscriptMirror('session', 512)
  const ops = [...turnOf('t1', 1, '一'.repeat(400)), ...turnOf('t2', 2, '二'.repeat(400))]

  const envelopes = push(mirror, ops)

  expect(envelopes.length).toBeGreaterThan(1)
  for (const envelope of envelopes) {
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(512 + 1024)
  }
})

test('splitting keeps the watermark contiguous so the client never sees a gap', () => {
  const mirror = new TranscriptMirror('session', 512)
  const envelopes = push(mirror, [
    ...turnOf('t1', 1, '一'.repeat(400)),
    ...turnOf('t2', 2, '二'.repeat(400)),
    ...turnOf('t3', 3, '三'.repeat(400)),
  ])

  expect(envelopes.map((envelope) => decode(envelope).seq)).toEqual(
    envelopes.map((_, at) => at + 1),
  )
})

test('every op survives the split, in order', () => {
  const mirror = new TranscriptMirror('session', 512)
  const ops = [
    ...turnOf('t1', 1, '一'.repeat(400)),
    ...turnOf('t2', 2, '二'.repeat(400)),
    ...turnOf('t3', 3, '三'.repeat(400)),
  ]

  const pushed = push(mirror, ops).flatMap((envelope) => decode(envelope).ops)

  expect(pushed).toEqual(ops)
})

test('the baseline page opens a window instead of sending everything at once', () => {
  const mirror = new TranscriptMirror('session', 1024)
  for (const [at, text] of ['一', '二', '三', '四'].entries()) {
    push(mirror, turnOf(`t${String(at + 1)}`, at + 1, text.repeat(400)))
  }

  const page = transcriptResponseSchema.parse(mirror.page('main'))

  expect(page.items.length).toBeGreaterThan(0)
  expect(page.items.length).toBeLessThan(4)
  expect(page.has_more).toBe(true)
  // 最新那一轮一定在：屏幕先画眼下，更早的再翻。
  expect(page.items.at(-1)).toMatchObject({ turnId: 't4' })
})

test('paging backwards with beforeTurn yields strictly earlier turns and terminates', () => {
  const mirror = new TranscriptMirror('session', 1024)
  for (const [at, text] of ['一', '二', '三', '四'].entries()) {
    push(mirror, turnOf(`t${String(at + 1)}`, at + 1, text.repeat(400)))
  }

  const first = transcriptResponseSchema.parse(mirror.page('main'))
  const oldest = first.items.find((item) => item.kind === 'turn')
  expect(oldest).toBeDefined()

  const earlier = transcriptResponseSchema.parse(mirror.page('main', oldest?.turnId))

  expect(earlier.items.length).toBeGreaterThan(0)
  // 必须严格更早：不推进会被客户端的 #coverBoundary 判成缺陷并抛错。
  for (const item of earlier.items) {
    if (item.kind === 'turn') {
      expect(item.ordinal).toBeLessThan(oldest?.ordinal ?? 0)
    }
  }
})

test('an unknown paging cursor yields an empty page instead of a non-advancing one', () => {
  const mirror = new TranscriptMirror('session', 1024)
  push(mirror, turnOf('t1', 1, '一'.repeat(400)))

  const page = transcriptResponseSchema.parse(mirror.page('main', 'nope'))

  expect(page.items).toEqual([])
  expect(page.has_more).toBe(false)
})

/*
 * 单条 op 自己就超预算：协议没有比 op 更细的切法，只能让它独占一行。
 * 这条钉的是「不静默丢载荷」——丢了就是屏幕少一段正文。
 */
test('an op larger than the budget still goes out whole on its own line', () => {
  const mirror = new TranscriptMirror('session', 256)
  const op = textOp('大'.repeat(1000))

  const envelopes = push(mirror, [op])

  expect(envelopes).toHaveLength(1)
  expect(decode(envelopes[0]).ops).toEqual([op])
})

test('catch-up that cannot fit reports incomplete so the client falls back to a page', () => {
  const mirror = new TranscriptMirror('session', 512)
  for (const [at, text] of ['一', '二', '三', '四'].entries()) {
    push(mirror, turnOf(`t${String(at + 1)}`, at + 1, text.repeat(400)))
  }

  const caught = mirror.catchUp('main', 0) as {
    batches: unknown[]
    latest_seq: number
    complete: boolean
  }

  expect(caught.batches.length).toBeGreaterThan(0)
  expect(caught.batches.length).toBeLessThan(4)
  expect(caught.complete).toBe(false)
  expect(caught.latest_seq).toBe(4)
})

test('catch-up that fits stays complete, so the client keeps folding batches', () => {
  const mirror = new TranscriptMirror('session')
  push(mirror, TURN)
  push(mirror, TURN)

  const caught = mirror.catchUp('main', 0) as { batches: unknown[]; complete: boolean }

  expect(caught.batches).toHaveLength(2)
  expect(caught.complete).toBe(true)
})

/*
 * 附件是页里唯一可能上百 MB 的东西（每张图内联 data URL，且整条会话累加）。
 * 开窗只裁 items 不够：图不按引用收口，一条贴过图的会话照样顶穿。
 */
test('the page drops attachments no visible turn references', () => {
  const mirror = new TranscriptMirror('session')
  push(mirror, turnOf('t1', 1, 'hi'))
  mirror.accept([
    {
      op: 'attachment.upsert',
      attachment: {
        attachmentId: 'orphan',
        mediaType: 'image/png',
        source: { kind: 'url', url: `data:image/png;base64,${'A'.repeat(4000)}` },
      },
    },
  ])

  const page = transcriptResponseSchema.parse(mirror.page('main'))

  expect(page.attachments).toEqual([])
})

test('the page keeps the attachments its visible turns point at', () => {
  const mirror = new TranscriptMirror('session')
  push(mirror, [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'running',
        origin: { kind: 'user' },
        prompt: 'hi',
        attachmentIds: ['kept'],
      },
    },
  ])
  mirror.accept([
    {
      op: 'attachment.upsert',
      attachment: {
        attachmentId: 'kept',
        mediaType: 'image/png',
        source: { kind: 'url', url: 'data:image/png;base64,AAAA' },
      },
    },
  ])

  const page = transcriptResponseSchema.parse(mirror.page('main'))

  expect(page.attachments.map((attachment) => attachment.attachmentId)).toEqual(['kept'])
})
/*
 * 屏幕窗口很小、历史很长时，页的两种行为各有一条判据（都是这次修缺陷时才有的形状）：
 * 1. 往回翻到镜像手上没有再早的段时，页要当场把更早那一段补进来（warm），而不是回空页；
 * 2. 「还有更早的」按 floor（显示经过的下界）判，不按这一页开出来的那一段判 —— 少了它，
 *    客户端以为到底了，被压掉的历史就永远翻不回来。
 */
/** 带段的轮：真实那条路上每一轮都有段，按段才看得出「手上已有的是哪一段」。 */
function stagedTurn(turnId: string, ordinal: number, text: string): TranscriptOperation[] {
  return [
    ...turnOf(turnId, ordinal, text),
    {
      op: 'step.upsert' as const,
      turnId,
      step: {
        kind: 'step' as const,
        stepId: `${turnId}.0`,
        turnId,
        ordinal: 0,
        state: 'completed' as const,
      },
    },
    {
      op: 'frame.upsert' as const,
      turnId,
      stepId: `${turnId}.0`,
      frame: { kind: 'text' as const, role: 'assistant' as const, frameId: `${turnId}.0.f0`, text },
    },
  ]
}

test('paging past the staged window warms an earlier stretch instead of answering empty', () => {
  const mirror = new TranscriptMirror('session', 1024)
  for (const [at, text] of ['一', '二', '三', '四'].entries()) {
    push(mirror, stagedTurn(`t${String(at + 1)}`, at + 1, text.repeat(400)))
  }

  /* 游标指向镜像手上最老那一轮：光靠手上这一窗开不出更早的页，得现补一段。 */
  const warmed: string[] = []
  const earlier = transcriptResponseSchema.parse(
    mirror.page('main', 't1', {
      floor: 't1',
      /* 补的那一段更早（真实那一条是从显示经过里现投影成 ops）。 */
      warm: (beforeTurn, stagedFrom) => {
        warmed.push(`${String(beforeTurn)}:${String(stagedFrom)}`)
        push(mirror, stagedTurn('t0', 0, '零'.repeat(400)))
      },
    }),
  )

  expect(warmed).toEqual(['t1:1'])
  expect(earlier.items.map((item) => (item.kind === 'turn' ? item.turnId : item.kind))).toEqual([
    't0',
  ])
})

test('a page that is not at the display floor still says there is more', () => {
  const mirror = new TranscriptMirror('session', 1024)
  for (const [at, text] of ['一', '二'].entries()) {
    push(mirror, turnOf(`t${String(at + 1)}`, at + 1, text.repeat(400)))
  }

  /* 这一页只开得出最新那一轮，而显示经过的下界是第 1 轮：要如实说还有更早的。 */
  const page = transcriptResponseSchema.parse(mirror.page('main', undefined, { floor: 't1' }))

  expect(page.has_more).toBe(true)
})
