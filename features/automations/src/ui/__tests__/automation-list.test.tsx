import { afterEach, describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import { cleanup, render, screen } from '@testing-library/react'
import type { Automation, AutomationRun } from '../../contract'
import type { AutomationsApi } from '../api'
import { AutomationList } from '../automation-list'
import { createAutomationsStore } from '../automations-store'

/*
 * 列表卡片的读数（产品负责人 2026-10-13 交办）：卡片只画任务定义 —— 标题、指令、
 * 计划、已运行次数 —— 不画上一次运行的结论。
 *
 * 结论那句是 agent 用 `automation_report` 交的正文，读起来就是对话里的聊天记录；
 * 摆在任务卡片上会被当成「任务里夹了一条聊天消息」。运行结果去编辑页的运行历史看
 * （`automation-run-history`），那里本来就逐条列着结论与系统消息。
 */

const RUN_SUMMARY = '当前时间 2026-10-11 00:17（+0800，周日）。工作区根目录共 23 个条目'

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    title: '测试任务：报告当前时间与工作区状态',
    prompt: '这是一个测试用的自动化任务，请报告当前时间与工作区状态。',
    schedule: { cron: '0 9 * * *', at: null, timeZone: 'Asia/Shanghai' },
    workspaceId: 'ws1',
    posture: 'auto-edit',
    model: null,
    thinking: null,
    threadMode: 'new',
    threadId: null,
    notify: 'attention',
    catchUp: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: null,
    issue: null,
    lastRun: null,
    ...over,
  }
}

function run(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1',
    automationId: 'a1',
    threadId: null,
    trigger: 'schedule',
    scheduledFor: null,
    startedAt: 0,
    settledAt: 1,
    outcome: 'succeeded',
    message: null,
    summary: null,
    attention: false,
    ...over,
  }
}

/** 这个用例用不到的命令：一律当作「不该被调用」 */
const unused = (): never => {
  throw new Error('这个用例不该走到这条命令')
}

function apiOf(row: Automation): AutomationsApi {
  return {
    list: async () => [row],
    get: async () => row,
    create: async () => unused(),
    update: async () => unused(),
    remove: async () => unused(),
    setEnabled: async () => unused(),
    runNow: async () => unused(),
    cancelRun: async () => unused(),
    runs: async () => [],
    previewSchedule: async () => ({ times: [], problem: null }),
    onChanged: () => ({ dispose: () => undefined }),
    onRunUpdated: () => ({ dispose: () => undefined }),
    onAttention: () => ({ dispose: () => undefined }),
    draftControls: async () => unused(),
  }
}

function mount(row: Automation, runs: readonly AutomationRun[] = []): void {
  const store = createAutomationsStore({ api: apiOf(row), logger: createTestLogger() })
  render(
    <AutomationList
      automations={[row]}
      onCreateBlank={() => undefined}
      onOpen={() => undefined}
      pending={[]}
      runsOf={() => runs}
      store={store}
    />,
  )
}

afterEach(() => {
  cleanup()
})

describe('automation list card', () => {
  test('只画任务定义：标题、指令、计划、已运行次数', () => {
    mount(automation({ lastRun: run({ summary: RUN_SUMMARY }) }), [run()])
    expect(screen.getByText('测试任务：报告当前时间与工作区状态')).toBeDefined()
    expect(screen.getByText('这是一个测试用的自动化任务，请报告当前时间与工作区状态。')).toBeDefined()
    expect(screen.getByText('每天 09:00')).toBeDefined()
    expect(screen.getByText('已运行 1 次')).toBeDefined()
  })

  test('上一次运行的结论不上卡片', () => {
    mount(automation({ lastRun: run({ summary: RUN_SUMMARY, attention: true }) }), [run()])
    /* 断言写成布尔：命中时 toBeNull 会把整个 DOM 打出来，红的时候反而看不清原因 */
    expect(screen.queryByText(RUN_SUMMARY) !== null).toBe(false)
    expect(screen.queryByText('需要关注') !== null).toBe(false)
  })
})
