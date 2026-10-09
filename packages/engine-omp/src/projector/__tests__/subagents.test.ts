import { describe, expect, test } from 'bun:test'
import {
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
} from '@oh-my-pi/pi-tui/overlays/session-observer-registry'
import { lifecycleFrameOf, progressFrameOf, SubagentLedger, taskStateOf } from '../subagents'

const ledger = (): SubagentLedger => new SubagentLedger({ now: () => 1_700_000_000_000 })

describe('频道常量', () => {
  test('从 omp 导入而不是手写字符串', () => {
    expect(TASK_SUBAGENT_LIFECYCLE_CHANNEL).toBe('task:subagent:lifecycle')
    expect(TASK_SUBAGENT_PROGRESS_CHANNEL).toBe('task:subagent:progress')
  })
})

describe('帧收窄', () => {
  test('生命周期帧缺少 id 时整帧作废', () => {
    expect(lifecycleFrameOf({ status: 'started' })).toBeNull()
    expect(lifecycleFrameOf(null)).toBeNull()
    expect(lifecycleFrameOf({ id: 'Anna', status: 'started', description: '查资料' })).toEqual({
      id: 'Anna',
      status: 'started',
      description: '查资料',
    })
  })

  test('进度帧缺少 progress.id 时整帧作废', () => {
    expect(progressFrameOf({ progress: {} })).toBeNull()
    expect(progressFrameOf({ progress: { id: 'Anna', status: 'running' } })?.progress.id).toBe('Anna')
  })
})

describe('taskStateOf', () => {
  test('逐档映射；认不出返回 null', () => {
    expect(taskStateOf('started')).toBe('running')
    expect(taskStateOf('completed')).toBe('completed')
    expect(taskStateOf('failed')).toBe('failed')
    expect(taskStateOf('aborted')).toBe('killed')
    expect(taskStateOf('???')).toBeNull()
    expect(taskStateOf(undefined)).toBeNull()
  })
})

describe('SubagentLedger', () => {
  test('生命周期帧产出一行 task，agentId 与 taskId 同值', () => {
    const ops = ledger().lifecycle({ id: 'Anna', status: 'started', description: '查资料' })
    expect(ops.length).toBe(1)
    const op = ops[0]
    expect(op?.op).toBe('task.upsert')
    if (op?.op !== 'task.upsert') throw new Error('形状不对')
    expect(op.task.taskId).toBe('Anna')
    expect(op.task.agentId).toBe('Anna')
    expect(op.task.state).toBe('running')
    expect(op.task.description).toBe('查资料')
    expect(op.task.endedAt).toBeUndefined()
  })

  test('重复的同一帧不产出（去重）', () => {
    const l = ledger()
    l.lifecycle({ id: 'Anna', status: 'started', description: '查资料' })
    expect(l.lifecycle({ id: 'Anna', status: 'started', description: '查资料' })).toEqual([])
  })

  test('已结的行不被迟到的运行中帧翻回去', () => {
    const l = ledger()
    l.lifecycle({ id: 'Anna', status: 'started' })
    l.lifecycle({ id: 'Anna', status: 'completed' })
    expect(l.lifecycle({ id: 'Anna', status: 'started' })).toEqual([])
    expect(l.tasks[0]?.state).toBe('completed')
  })

  test('进度帧给出输出尾巴、模型与档位', () => {
    const l = ledger()
    l.lifecycle({ id: 'Anna', status: 'started', description: '查资料' })
    const ops = l.progress({
      task: '查资料',
      progress: {
        id: 'Anna',
        status: 'running',
        lastIntent: '在读文档',
        recentOutput: ['第一行', '第二行'],
        resolvedModel: 'mock/mock-model',
        resolvedThinkingLevel: 'high',
      },
    })
    expect(ops.length).toBe(1)
    const task = l.tasks[0]
    expect(task?.outputTail).toBe('第一行\n第二行')
    expect(task?.model).toBe('mock/mock-model')
    expect(task?.thinkingEffort).toBe('high')
    expect(task?.description).toBe('在读文档')
  })

  test('进度帧不改变已结的行', () => {
    const l = ledger()
    l.lifecycle({ id: 'Anna', status: 'started' })
    l.lifecycle({ id: 'Anna', status: 'completed' })
    expect(l.progress({ progress: { id: 'Anna', status: 'running', recentOutput: ['x'] } })).toEqual([])
    expect(l.tasks[0]?.state).toBe('completed')
  })

  test('认不出状态的帧整帧不落', () => {
    expect(ledger().lifecycle({ id: 'Anna', status: 'weird' })).toEqual([])
  })

  test('detached 标志原样带上', () => {
    const l = ledger()
    const ops = l.lifecycle({ id: 'Anna', status: 'started', detached: true })
    const op = ops[0]
    if (op?.op !== 'task.upsert') throw new Error('形状不对')
    expect(op.task.detached).toBe(true)
  })
})
