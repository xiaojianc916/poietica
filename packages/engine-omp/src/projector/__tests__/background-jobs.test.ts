import { describe, expect, test } from 'bun:test'
import type { TranscriptOperation, TranscriptTask } from '@poietica/transcript'
import { BackgroundJobLedger, jobIdOf, jobTaskId } from '../background-jobs'

const taskOf = (ops: readonly TranscriptOperation[]): TranscriptTask => {
  const op = ops[0]
  if (op?.op !== 'task.upsert') throw new Error('expected task.upsert')
  return op.task
}

describe('作业号', () => {
  test('前缀往返；子代理号不是作业号', () => {
    expect(jobIdOf(jobTaskId('bg_1'))).toBe('bg_1')
    expect(jobIdOf('SwiftFalcon')).toBeNull()
    expect(jobIdOf('job:')).toBeNull()
  })
})

describe('BackgroundJobLedger', () => {
  test('bash → shell、eval → tool，都是 detached；task 类不列（归智能体那一节）', () => {
    const ledger = new BackgroundJobLedger()
    const ops = ledger.reconcile({
      running: [
        { id: 'a', type: 'bash', status: 'running', label: 'bun dev', startTime: 1_000 },
        { id: 'b', type: 'eval', status: 'running', command: 'print(1)' },
        { id: 'c', type: 'task', status: 'running', label: 'Anna' },
      ],
      recent: [],
    })
    expect(ops).toHaveLength(2)
    expect(taskOf(ops)).toMatchObject({ taskId: 'job:a', kind: 'shell', state: 'running', detached: true })
    expect(taskOf(ops.slice(1))).toMatchObject({ taskId: 'job:b', kind: 'tool', description: 'print(1)' })
    expect(ledger.hasRunning).toBe(true)
  })

  test('没变不发；cancelled → killed；终态不再改', () => {
    const ledger = new BackgroundJobLedger()
    const running = { running: [{ id: 'a', type: 'bash', status: 'running' }], recent: [] }
    ledger.reconcile(running)
    expect(ledger.reconcile(running)).toEqual([])
    const killed = ledger.reconcile({
      running: [],
      recent: [{ id: 'a', type: 'bash', status: 'cancelled', endTime: 5 }],
    })
    expect(taskOf(killed).state).toBe('killed')
    expect(ledger.reconcile({ running: [], recent: [{ id: 'a', type: 'bash', status: 'completed' }] })).toEqual([])
    expect(ledger.hasRunning).toBe(false)
  })

  test('跑着却从快照里消失 → lost，不在面板上永远转圈', () => {
    const ledger = new BackgroundJobLedger()
    ledger.reconcile({ running: [{ id: 'a', type: 'bash', status: 'running' }], recent: [] })
    const ops = ledger.reconcile({ running: [], recent: [] })
    expect(taskOf(ops)).toMatchObject({ state: 'lost', stateReason: 'job_vanished' })
    expect(ledger.tasks).toHaveLength(1)
  })
})
