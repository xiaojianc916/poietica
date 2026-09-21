import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TranscriptPage } from '@poietica/conversation'
import { type AgentTranscriptSnapshot, transcriptResponseSchema } from '@poietica/transcript'

/*
 * 真实经过的一次转录，取自本机 kimi web 的
 *   GET /api/v1/sessions/{id}/transcript?agent_id=main
 * 落盘的是 data 那一层（HTTP 信封由 Rust 在 crates/kap-client 的 rest.rs 拆掉，
 * 过桥的只有它）。
 *
 * 本机最大的真实对话是 2 轮 / 263 帧 / 600 KB 量级；"超大"那一档用真实轮次模板
 * 复制拼接 —— 形状仍是 server 发的那种，只是轮数可控。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))

interface WireStep {
  frames: unknown[]
  stepId: string
  turnId: string
}
interface WireTurn {
  kind: string
  turnId: string
  ordinal: number
  steps: WireStep[]
}
interface WirePage {
  items: WireTurn[]
  [key: string]: unknown
}

export interface Fixture {
  readonly name: string
  readonly bytes: number
  readonly turns: number
  readonly steps: number
  readonly frames: number
  /** server 应答的那份 JSON 文本。 */
  readonly json: string
}

function measure(name: string, json: string): Fixture {
  const page = JSON.parse(json) as WirePage
  let turns = 0
  let steps = 0
  let frames = 0
  for (const item of page.items) {
    if (item.kind !== 'turn') {
      continue
    }
    turns += 1
    for (const step of item.steps) {
      steps += 1
      frames += step.frames.length
    }
  }
  return { name, bytes: Buffer.byteLength(json), turns, steps, frames, json }
}

export function fixture(name: string): Fixture {
  return measure(name, readFileSync(path.join(HERE, 'fixtures', `${name}.json`), 'utf8'))
}

/** 把真实页上的轮次复制 n 份接在后面，凑出"超大对话"。 */
export function scaled(source: Fixture, copies: number): Fixture {
  const page = JSON.parse(source.json) as WirePage
  const origin = page.items
  const base = origin.filter((item) => item.kind === 'turn').length
  const items: WireTurn[] = []
  for (let copy = 0; copy < copies; copy += 1) {
    for (const item of origin) {
      const turn = structuredClone(item)
      if (turn.kind === 'turn') {
        turn.ordinal += copy * base
        turn.turnId = `${turn.turnId}~${String(copy)}`
        for (const step of turn.steps) {
          step.turnId = turn.turnId
          step.stepId = `${step.stepId}~${String(copy)}`
        }
      }
      items.push(turn)
    }
  }
  return measure(`${source.name}x${String(copies)}`, JSON.stringify({ ...page, items }))
}

/**
 * 包边界的解码：JSON 文本 -> 校验过的页 —— 与
 * packages/native-bridge/src/conversation/transcript-decoding.ts 的 transcriptPageOf 同一条
 * （zod 校验 + snake_case 改名；改名只挪引用，成本 O(1)，所以量到的就是那一步的真实成本）。
 */
export function pageOf(json: string): TranscriptPage {
  const data = transcriptResponseSchema.parse(JSON.parse(json))
  return {
    agentId: data.agent_id,
    items: data.items,
    hasMoreOlder: data.has_more,
    tasks: data.tasks,
    interactions: data.interactions,
    attachments: data.attachments,
    todos: data.todos,
    prompts: data.prompts,
    meta: data.meta,
    agents: data.agents,
    pendingInteractions: data.pending_interactions,
    seq: data.seq ?? 0,
  } as TranscriptPage
}

/** 页里那份快照；TranscriptPage 与快照的差别只在几个信封字段。 */
export function snapshotOf(page: TranscriptPage): AgentTranscriptSnapshot {
  return {
    items: page.items,
    tasks: page.tasks,
    interactions: page.interactions,
    attachments: page.attachments,
    todos: page.todos,
    prompts: page.prompts,
    meta: page.meta,
    hasMoreOlder: page.hasMoreOlder,
  } as AgentTranscriptSnapshot
}
