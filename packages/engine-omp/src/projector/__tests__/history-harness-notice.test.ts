import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState, type TranscriptPage } from '@poietica/transcript'
import { lastTurnOrdinal, type OmpMessage, projectHistoryPage } from '../history'
import { LiveProjector } from '../live'
import { assistant, assistantTexts, prompts, T0, toolCall, toolResult, user } from './fixtures/history'

/*
 * R-25：omp 写给模型看的系统通知（后台任务做完了、受管进程退出了、迟到的 LSP 诊断）是 role:custom、
 * display:true 的消息，正文包在 <system-notice> 里。实时那条路从不画它（它没有流式正文）；
 * 历史这边曾把它当成「这一轮里的一段」，整段原文（任务输出、脚本源码）画成了助手正文。
 */

const done = (message: OmpMessage, completedAt: number): OmpMessage => ({ ...message, completedAt: T0 + completedAt })
const resultAt = (id: string, content: unknown, at: number): OmpMessage => ({
  ...toolResult(id, content),
  timestamp: T0 + at,
})

const NOTICE_TEXT = [
  '<system-notice>',
  '2 background jobs have completed. Resume your work using the results below.',
  '',
  '── Job bg_1 (P="node_modules/.bun/x"; echo "=== buildSessionContext ===") ──',
  '=== buildSessionContext ===',
  'export function buildSessionContext(entries) {',
  '── Job bg_2 (grep -n tree src) ──',
  'src/session/tree.ts:12: export class SessionTree',
  '</system-notice>',
].join('\n')

/** omp `buildAsyncResultBatchMessage` 的形状（session/async-job-delivery.ts） */
const asyncResult = (at: number, content: unknown = NOTICE_TEXT): OmpMessage => ({
  role: 'custom',
  customType: 'async-result',
  content,
  display: true,
  attribution: 'agent',
  details: {
    meta: { source: { type: 'report', value: 'background job delivery' } },
    jobs: [
      { jobId: 'bg_1', type: 'bash', status: 'completed' },
      { jobId: 'bg_2', type: 'bash', status: 'completed' },
    ],
  },
  timestamp: T0 + at,
})

/** 截图那一轮：提问、插话「快点啊」、两条命令放到后台跑、做完的通知送进同一次运行、接着作答 */
const reported: OmpMessage[] = [
  user('omp的会话树有什么用？', 0),
  done(toolCall('c1', 'bash', { command: 'P=node_modules/.bun/x; echo ...', async: true }, 1_000), 2_000),
  resultAt('c1', 'Background job bg_1 started', 2_500),
  done(toolCall('c2', 'bash', { command: 'grep -n tree src', async: true }, 3_000), 4_000),
  resultAt('c2', 'Background job bg_2 started', 4_500),
  user('快点啊', 2_000),
  done(assistant('等两条命令跑完', 6_000), 8_000),
  asyncResult(30_000),
  done(toolCall('c3', 'read', { path: 'src/session/tree.ts' }, 31_000), 32_000),
  resultAt('c3', 'export class SessionTree', 33_000),
  done(assistant('会话树记录每一次分叉……', 34_000), 60_000),
]

function allText(page: TranscriptPage): string {
  return JSON.stringify(page.items)
}

/** 屏幕上每一轮依次上屏的帧（实时那条开场用户帧不带 origin、不上屏，不算） */
function shape(page: TranscriptPage) {
  return page.items.flatMap((item) =>
    item.kind === 'turn' ? [{ prompt: item.prompt, frames: item.steps.flatMap((s) => s.frames.flatMap(labelOf)) }] : [],
  )
}

type Frame = Extract<TranscriptPage['items'][number], { kind: 'turn' }>['steps'][number]['frames'][number]

function labelOf(f: Frame): string[] {
  if (f.kind === 'tool') return [`tool:${f.name}`]
  if (f.kind !== 'text') return [f.kind]
  return f.role === 'user' && f.origin === undefined ? [] : [`${f.role}:${f.text}`]
}

describe('omp 的系统通知不上屏（R-25）', () => {
  test('截图那一轮：后台任务的完成通知不画成助手正文，插话照旧是插话、只有一轮', () => {
    const page = projectHistoryPage(reported, null)
    expect(page.items.length).toBe(1)
    expect(prompts(page)).toEqual(['omp的会话树有什么用？'])
    expect(assistantTexts(page)).toEqual(['等两条命令跑完', '会话树记录每一次分叉……'])
    const text = allText(page)
    expect(text).not.toContain('background jobs have completed')
    expect(text).not.toContain('buildSessionContext')
    expect(text).not.toContain('system-notice')
    expect(shape(page)[0]?.frames).toEqual([
      'tool:bash',
      'tool:bash',
      'user:快点啊',
      'assistant:等两条命令跑完',
      'tool:read',
      'assistant:会话树记录每一次分叉……',
    ])
    expect(lastTurnOrdinal(reported)).toBe(1)
  })

  test('通知带图（任务的截图）：文字与图都不上屏，也不在轮头挂号', () => {
    const withImage = asyncResult(30_000, [
      { type: 'text', text: NOTICE_TEXT },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    const page = projectHistoryPage([user('截个图', 0), done(assistant('好', 1_000), 2_000), withImage], null)
    expect(page.items.length).toBe(1)
    expect(assistantTexts(page)).toEqual(['好'])
    expect(page.attachments ?? []).toEqual([])
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && (turn.attachmentIds ?? [])).toEqual([])
    expect(allText(page)).not.toContain('background jobs have completed')
  })

  test('其他系统通知同样不上屏：受管进程退出、迟到的 LSP 诊断、任何包在 harness 标签里的 custom 正文', () => {
    const notices: OmpMessage[] = [
      {
        role: 'custom',
        customType: 'launch-completion',
        content: 'Supervised process dev exited (code 0)',
        display: true,
        attribution: 'agent',
        timestamp: T0 + 3_000,
      },
      {
        role: 'custom',
        customType: 'lsp-late-diagnostic',
        content: 'Late diagnostics for a.ts: 1 error',
        display: true,
        attribution: 'agent',
        timestamp: T0 + 4_000,
      },
      {
        role: 'custom',
        customType: 'some-future-notice',
        content: '  <system-reminder>\nkeep going\n</system-reminder>',
        display: true,
        attribution: 'agent',
        timestamp: T0 + 5_000,
      },
    ]
    const page = projectHistoryPage(
      [user('跑起来', 0), done(assistant('跑着', 1_000), 2_000), ...notices, done(assistant('好了', 6_000), 7_000)],
      null,
    )
    expect(page.items.length).toBe(1)
    expect(assistantTexts(page)).toEqual(['跑着', '好了'])
    const text = allText(page)
    expect(text).not.toContain('exited')
    expect(text).not.toContain('Late diagnostics')
    expect(text).not.toContain('keep going')
  })

  test('还开着的那一轮：通知之后模型还没产出，最后一段（上一段）留 running，轮头不变', () => {
    const page = projectHistoryPage(
      [user('跑起来', 0), done(assistant('等它跑完', 1_000), 2_000), asyncResult(10_000)],
      null,
      {
        isTurnOpen: true,
      },
    )
    expect(page.items.length).toBe(1)
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.state).toBe('running')
    expect(assistantTexts(page)).toEqual(['等它跑完'])
  })
})

describe('实时与重开一致（R-25）', () => {
  test('同一次运行里收到后台任务的通知：实时投影与历史投影的轮数、人话、帧序一致', () => {
    const p = new LiveProjector({ now: () => T0 })
    /* 实时那条路上通知只有 message_start / message_end，没有流式正文，投影层收不到它的任何东西 */
    const liveOps = [
      ...p.userTurn({ text: 'omp的会话树有什么用？' }),
      ...p.toolStart({ toolCallId: 'c1', toolName: 'bash', args: { command: 'P=node_modules/.bun/x; echo ...' } }),
      ...p.toolEnd({
        toolCallId: 'c1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'Background job bg_1 started' }], details: {} },
      }),
      ...p.toolStart({ toolCallId: 'c2', toolName: 'bash', args: { command: 'grep -n tree src' } }),
      ...p.toolEnd({
        toolCallId: 'c2',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'Background job bg_2 started' }], details: {} },
      }),
      ...p.steeredFrame('快点啊'),
      ...p.textDelta('等两条命令跑完'),
      ...p.toolStart({ toolCallId: 'c3', toolName: 'read', args: { path: 'src/session/tree.ts' } }),
      ...p.toolEnd({
        toolCallId: 'c3',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'export class SessionTree' }], details: {} },
      }),
      ...p.textDelta('会话树记录每一次分叉……'),
      ...p.turnEnd('completed', null),
    ]
    const live = pageFromState(applyOps(emptyTimeline(), liveOps)) as unknown as TranscriptPage
    const history = projectHistoryPage(reported, null)
    expect(shape(history)).toEqual(shape(live))
  })
})
