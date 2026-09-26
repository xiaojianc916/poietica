import { describe, expect, it } from 'bun:test'
import type { AgentTranscriptSnapshot, TranscriptInteraction } from '@poietica/transcript'
import { activeScope, pendingInteractions } from '../../timeline/timeline-queries'
import { projectTranscript } from '../transcript-projector'

/*
 * 投影层对未结交互的读法：桥现在才产得出这些 op（见 packages/agent-bridge 的
 * projection.ts 与 main.ts 的 onDialogLifecycle），而屏幕靠同一条链把带子挂出来。
 *
 * 这里钉三个判据，它们正是「三颗按钮会不会出现」的全部条件：
 * 相位变成 awaiting_permission、那件审批进得了 active 段、它的主语是 agent 算好的
 * 「将做什么」而不是工具名。
 */

const snapshot = (interactions: readonly TranscriptInteraction[]): AgentTranscriptSnapshot => ({
  items: [],
  tasks: [],
  interactions,
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
})

const approval = (state: TranscriptInteraction['state']): TranscriptInteraction => ({
  interactionId: 'd1',
  interactionKind: 'approval',
  state,
  toolCallId: 'bash',
  request: { method: 'select', toolName: 'bash', detail: 'Command: bun run check' },
})

describe('待答审批的投影', () => {
  it('有 pending 审批时相位是 awaiting_permission —— 三颗按钮的挂载条件', () => {
    const timeline = projectTranscript(snapshot([approval('pending')]))

    expect(timeline.status).toBe('awaiting_permission')
    // 这就是 assistant-surface 那一句 `blocked === undefined ? null : <PermissionDock/>`。
    expect(pendingInteractions(activeScope(timeline)).permission?.requestId).toBe('d1')
  })

  it('主语是 agent 算好的「将做什么」，不是工具名', () => {
    const timeline = projectTranscript(snapshot([approval('pending')]))
    const item = pendingInteractions(activeScope(timeline)).permission

    // 「要不要允许 Bash」回答不了任何问题；带子上印的是将跑哪条命令。
    expect(item?.headline).toBe('Command: bun run check')
    expect(item?.subject).toBe('bash')
  })

  it('没有待答审批时相位不是 awaiting_permission，带子不出现', () => {
    for (const state of ['approved', 'rejected', 'cancelled'] as const) {
      const timeline = projectTranscript(snapshot([approval(state)]))

      expect(timeline.status).not.toBe('awaiting_permission')
      expect(pendingInteractions(activeScope(timeline)).permission).toBeUndefined()
    }
  })

  it('题组走 awaiting_question，不与审批抢同一颗带子', () => {
    const questions = [
      {
        id: 'q1',
        question: '选哪条路？',
        options: [{ id: 'o0', label: '甲' }],
        multiSelect: false,
        allowOther: true,
      },
    ]
    const timeline = projectTranscript(
      snapshot([
        {
          interactionId: 'd2',
          interactionKind: 'question',
          state: 'pending',
          toolCallId: 'ask',
          request: { questions },
        },
      ]),
    )

    expect(timeline.status).toBe('awaiting_question')
    const waiting = pendingInteractions(activeScope(timeline))
    // 两条队列互斥：题在等的时候审批那一条是空的（timeline-queries 的分支）。
    expect(waiting.permission).toBeUndefined()
    expect(waiting.question?.questionId).toBe('d2')
    // 面板要的题组必须真是那几道，空题组会让它抛（`收到一组空题`）。
    expect(waiting.question?.questions).toHaveLength(1)
  })

  it('两个都是 pending 时审批优先 —— 一次只画一件', () => {
    const timeline = projectTranscript(
      snapshot([
        approval('pending'),
        {
          interactionId: 'd2',
          interactionKind: 'question',
          state: 'pending',
          toolCallId: 'ask',
          request: { questions: [] },
        },
      ]),
    )

    expect(timeline.status).toBe('awaiting_permission')
    expect(pendingInteractions(activeScope(timeline)).permission?.requestId).toBe('d1')
  })
})
