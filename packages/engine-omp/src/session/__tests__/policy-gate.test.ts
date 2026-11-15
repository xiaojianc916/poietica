import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExtensionFactory, ToolCallEvent } from '@oh-my-pi/pi-coding-agent'
import type { ArpPolicyCheckParams, ArpPolicyDecision } from '@poietica/runtime-protocol'
import { createPolicyGate, ensurePolicyExtensionFile, type PolicyApprovalRequest, policyGateFor } from '../policy-gate'

type Handler = (event: ToolCallEvent, ctx: { cwd: string }) => Promise<{ block?: boolean; reason?: string } | undefined>

const BASH = { toolName: 'bash', toolCallId: 'call-1', input: { command: 'ls' } } as ToolCallEvent
const ASK_DECISION: ArpPolicyDecision = {
  action: 'ask',
  rule: 'command.unknown',
  reason: '命令不在安全表内',
  risk: 'high',
  category: 'exec',
  checkpoint: true,
}

function harness(options?: {
  readonly decision?: ArpPolicyDecision
  readonly checkThrows?: boolean
  readonly approved?: boolean
  readonly session?: boolean
  readonly approval?: 'read' | 'write' | 'exec'
}) {
  const requests: ArpPolicyCheckParams[] = []
  const approvals: PolicyApprovalRequest[] = []
  let handler: Handler | undefined
  const gate = createPolicyGate({
    sessionKey: 'thread-1',
    preset: 'ask',
    approvalOf: () => options?.approval,
    check: async (request) => {
      requests.push(request)
      if (options?.checkThrows === true) throw new Error('core offline')
      return (
        options?.decision ?? {
          action: 'allow',
          rule: 'test.allow',
          reason: 'ok',
          risk: 'low',
          category: 'meta',
          checkpoint: false,
        }
      )
    },
  })
  gate.bindApproval(async (request) => {
    approvals.push(request)
    return { approved: options?.approved ?? true, session: options?.session ?? false }
  })
  gate.extension({
    on: (event: string, fn: Handler) => {
      if (event === 'tool_call') handler = fn
    },
  } as unknown as Parameters<ExtensionFactory>[0])
  return { gate, requests, approvals, run: (event: ToolCallEvent = BASH) => handler!(event, { cwd: 'D:/ws' }) }
}

describe('policy gate', () => {
  test('allow 直接放行，并把档位与原始入参交给 Core', async () => {
    const h = harness()
    expect(await h.run()).toBeUndefined()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({
      sessionKey: 'thread-1',
      toolName: 'bash',
      toolCallId: 'call-1',
      cwd: 'D:/ws',
      preset: 'ask',
      input: { command: 'ls' },
    })
  })

  test('deny 拦下工具，原因里带规则码', async () => {
    const h = harness({
      decision: {
        action: 'deny',
        rule: 'command.system_destructive',
        reason: '命中危险命令规则',
        risk: 'high',
        category: 'exec',
        checkpoint: true,
      },
    })
    expect(await h.run()).toEqual({
      block: true,
      reason: '策略拒绝：命中危险命令规则（command.system_destructive）',
    })
  })

  test('ask 批准后放行，审批卡片拿到工具名与具体命令', async () => {
    const h = harness({ decision: ASK_DECISION })
    expect(await h.run()).toBeUndefined()
    expect(h.approvals).toEqual([
      {
        tool: 'bash',
        detail: 'Command: ls',
        rule: 'command.unknown',
        reason: '命令不在安全表内',
        risk: 'high',
        category: 'exec',
      },
    ])
  })

  test('ask 拒绝后拦下', async () => {
    const h = harness({
      decision: ASK_DECISION,
      approved: false,
    })
    expect(await h.run()).toEqual({ block: true, reason: '用户拒绝：命令不在安全表内（command.unknown）' })
  })

  test('选了本会话放行后，下一次不再问 Core，也不再审批', async () => {
    const h = harness({
      decision: ASK_DECISION,
      session: true,
    })
    expect(await h.run()).toBeUndefined()
    expect(await h.run()).toBeUndefined()
    expect(h.requests).toHaveLength(1)
    expect(h.approvals).toHaveLength(1)
  })

  test('产品工具把自报的能力等级一起交给 Core', async () => {
    const h = harness({ approval: 'write' })
    expect(await h.run()).toBeUndefined()
    expect(h.requests[0]?.approval).toBe('write')
  })

  test('Core 不可用时 fail closed', async () => {
    const h = harness({ checkThrows: true })
    expect(await h.run()).toEqual({ block: true, reason: '策略拒绝：core offline（policy.unavailable）' })
  })

  test('setPreset 改的是下一次请求的档位', async () => {
    const h = harness()
    h.gate.setPreset('full-access')
    await h.run()
    expect(h.requests[0]?.preset).toBe('full-access')
  })
})

describe('策略门注册表与文件扩展', () => {
  const allow = async (): Promise<ArpPolicyDecision> => ({
    action: 'allow',
    rule: 'test',
    reason: '',
    risk: 'low',
    category: 'meta',
    checkpoint: false,
  })

  test('同 cwd 取最严格的门；子代理的未知 cwd 落到最近的门', () => {
    const lenient = createPolicyGate({
      sessionKey: 'a',
      preset: 'full-access',
      cwd: 'D:/ws',
      check: allow,
      approvalOf: () => undefined,
    })
    const strict = createPolicyGate({
      sessionKey: 'b',
      preset: 'ask',
      cwd: 'D:/ws',
      check: allow,
      approvalOf: () => undefined,
    })
    expect(policyGateFor('D:/ws')).toBe(strict)
    expect(policyGateFor('D:/elsewhere')).toBe(strict)
    lenient.dispose()
    strict.dispose()
  })

  test('文件扩展是稳定的 mjs，只调进程内桥', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poietica-policy-'))
    try {
      const file = ensurePolicyExtensionFile(dir)
      const source = readFileSync(file, 'utf8')
      expect(source).toContain('__poieticaPolicyBridge')
      expect(source).toContain('tool_call')
      expect(source).not.toContain('import ')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
