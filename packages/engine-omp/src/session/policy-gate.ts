import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ExtensionFactory, ToolCallEvent } from '@oh-my-pi/pi-coding-agent'
import type { ArpPolicyCheckParams, ArpPolicyDecision, ArpPolicyPreset } from '@poietica/runtime-protocol'

/**
 * 执行安全平面的第一道防线（架构设计 §13.1）：omp 的每次工具调用先问 Core。
 *
 * 生产路径是**文件扩展**：它随 `additionalExtensionPaths` 装入主会话，又由 omp 的 task 执行器
 * 以 `preloadedExtensionPaths` 传给子代理，所以子代理也走同一道门。扩展本身只调进程内的
 * `globalThis.__poieticaPolicyBridge`；按 cwd 找到当前工作区的策略门。
 */
export interface PolicyApprovalRequest {
  readonly tool: string
  readonly detail: string
  readonly rule: string
  readonly reason: string
  readonly risk: 'low' | 'medium' | 'high'
  readonly category: string
}

export interface PolicyApprovalResult {
  readonly approved: boolean
  /** 人选了「本会话都放行」 */
  readonly session: boolean
}

type ToolCallResult = { block: true; reason: string } | undefined

export interface PolicyBridge {
  toolCall(event: ToolCallEvent, ctx: PolicyBridgeContext): Promise<ToolCallResult>
}

/** 扩展交来的那一格：cwd 是兜底，会话身份才是精确路由的依据（见 `policyGateFor`）。 */
export interface PolicyBridgeContext {
  readonly cwd: string
  readonly sessionManager?: unknown
}

declare global {
  var __poieticaPolicyBridge: PolicyBridge | undefined
}

export interface PolicyGate {
  /** 单元测试与进程内替身用的 inline factory；生产会话走文件扩展。 */
  readonly extension: ExtensionFactory
  handle(event: ToolCallEvent, cwd: string): Promise<ToolCallResult>
  preset(): ArpPolicyPreset
  setPreset(preset: ArpPolicyPreset): void
  bindApproval(approval: (request: PolicyApprovalRequest) => Promise<PolicyApprovalResult>): void
  /** 把 omp 的会话身份绑到这道门：工具调用按会话精确路由，不再靠 cwd 猜是谁在调用。 */
  bindSession(identity: PolicySessionIdentity): void
  dispose(): void
}

export interface PolicySessionIdentity {
  readonly sessionId: string
  /** 会话文件路径：子代理的会话头把它记作 `parentSession`，所以这张表也是父会话的反查表。 */
  readonly sessionFile?: string
}

/** 一次工具调用的归属：会话号 → 父会话文件 → cwd 兜底。 */
export interface PolicyGateLocation {
  readonly cwd: string
  readonly sessionId?: string
  readonly parentSession?: string
}

export interface CreatePolicyGateOptions {
  readonly sessionKey: string
  readonly preset: ArpPolicyPreset
  /** 注册到按 cwd 的进程内策略门表；测试可不给，避免跨用例串门。 */
  readonly cwd?: string
  readonly check: (request: ArpPolicyCheckParams) => Promise<ArpPolicyDecision>
  /** 产品工具自报的能力等级；内置工具没有。 */
  readonly approvalOf: (tool: string) => 'read' | 'write' | 'exec' | undefined
  /** 用户选了「本会话都放行」：把放行记回 Core。 */
  readonly grant?: (toolName: string) => Promise<void> | void
}

const RESTRICTIVENESS: Record<ArpPolicyPreset, number> = {
  ask: 1,
  'auto-edit': 2,
  'full-access': 3,
}

const gatesByCwd = new Map<string, Set<PolicyGate>>()
/** 会话号 / 会话文件路径 → 那道门。主会话的工具调用必须落到**自己**的门上。 */
const gatesBySession = new Map<string, PolicyGate>()
let lastGate: PolicyGate | undefined

/**
 * 一次工具调用该问哪道门。
 *
 * - **会话号命中**：这是主会话自己的门 —— 同一 cwd 里别的线程是什么档位与它无关。
 *   从前只按 cwd 取「最严格的门」，于是完全访问的线程被只读线程的门拦住、审批卡片
 *   跑到另一条对话里（真实故障：三条新对话的审批全是别人那一轮的写命令）。
 * - **父会话文件命中**：omp 的子代理没有自己的门，会话头的 `parentSession` 指回父会话，
 *   它的工具调用按父线程的档位裁决。
 * - 都没有才退回 cwd 表（取最严格）与最近建的门：认不出的会话宁可问得严一点。
 */
export function policyGateFor(location: PolicyGateLocation): PolicyGate | undefined {
  const own = location.sessionId === undefined ? undefined : gatesBySession.get(location.sessionId)
  if (own !== undefined) return own
  const parent = location.parentSession === undefined ? undefined : gatesBySession.get(location.parentSession)
  if (parent !== undefined) return parent
  const held = gatesByCwd.get(path.resolve(location.cwd))
  if (held === undefined || held.size === 0) return lastGate
  let strictest: PolicyGate | undefined
  for (const gate of held) {
    if (strictest === undefined || RESTRICTIVENESS[gate.preset()] < RESTRICTIVENESS[strictest.preset()]) {
      strictest = gate
    }
  }
  return strictest
}

/** 扩展上下文里能读到会话号的那两格（读不出来就当没有，不猜）。 */
function readIdentity(read: () => string | undefined): string | undefined {
  try {
    const value = read()
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    /* 认不出的会话退回 cwd 兜底，不能因为读身份失败就放行或炸掉一次工具调用 */
    return undefined
  }
}

function locationOf(ctx: PolicyBridgeContext): PolicyGateLocation {
  const manager = ctx.sessionManager as
    { getSessionId?(): string; getHeader?(): { parentSession?: string } | undefined } | undefined
  const sessionId = readIdentity(() => manager?.getSessionId?.())
  const parentSession = readIdentity(() => manager?.getHeader?.()?.parentSession)
  return {
    cwd: ctx.cwd,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(parentSession === undefined ? {} : { parentSession }),
  }
}

/** Worker 启动时装一次：文件扩展只认这一格。 */
export function installPolicyBridge(): void {
  globalThis.__poieticaPolicyBridge = {
    async toolCall(event, ctx) {
      const gate = policyGateFor(locationOf(ctx))
      if (gate === undefined) return { block: true, reason: '策略门尚未就绪' }
      return await gate.handle(event, ctx.cwd)
    },
  }
}

const EXTENSION_SOURCE = `export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const bridge = globalThis.__poieticaPolicyBridge;
    if (bridge === undefined) return { block: true, reason: "策略桥不可用" };
    return await bridge.toolCall(event, ctx);
  });
}
`

/** 写一个稳定的文件扩展；omp 的子代理按路径继承它，inline factory 不会。 */
export function ensurePolicyExtensionFile(dir: string): string {
  const file = path.join(dir, 'poietica-policy.mjs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, EXTENSION_SOURCE, 'utf8')
  return file
}

export function createPolicyGate(o: CreatePolicyGateOptions): PolicyGate {
  let preset = o.preset
  let approval: ((request: PolicyApprovalRequest) => Promise<PolicyApprovalResult>) | undefined
  const granted = new Set<string>()
  /* 这道门登记进 `gatesBySession` 的那些键（会话号 + 会话文件），dispose 时要逐个摘掉 */
  const bound = new Set<string>()

  const decide = async (event: ToolCallEvent, cwd: string): Promise<ArpPolicyDecision> => {
    if (granted.has(event.toolName)) {
      return {
        action: 'allow',
        rule: 'runtime.session_grant',
        reason: '本会话已放行该工具',
        risk: 'low',
        category: 'meta',
        checkpoint: false,
      }
    }
    try {
      const approvalCategory = o.approvalOf(event.toolName)
      return await o.check({
        sessionKey: o.sessionKey,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        cwd,
        preset,
        ...(approvalCategory === undefined ? {} : { approval: approvalCategory }),
        input: Object.fromEntries(Object.entries(event.input)),
      })
    } catch (error) {
      /* 裁决不可用就 fail closed：宁可不跑，也不让一个没有策略的工具悄悄执行。 */
      return {
        action: 'deny',
        rule: 'policy.unavailable',
        reason: error instanceof Error ? error.message : String(error),
        risk: 'high',
        category: 'unknown',
        checkpoint: false,
      }
    }
  }

  const ask = async (event: ToolCallEvent, decision: ArpPolicyDecision): Promise<ToolCallResult> => {
    if (approval === undefined) return { block: true, reason: '策略要求审批，但当前没有可用的交互界面' }
    const answer = await approval({
      tool: event.toolName,
      detail: describeToolCall(event),
      rule: decision.rule,
      reason: decision.reason,
      risk: decision.risk,
      category: decision.category,
    })
    if (!answer.approved) return { block: true, reason: `用户拒绝：${decision.reason}（${decision.rule}）` }
    if (answer.session) {
      granted.add(event.toolName)
      await o.grant?.(event.toolName)
    }
    return
  }

  const handle = async (event: ToolCallEvent, cwd: string): Promise<ToolCallResult> => {
    const decision = await decide(event, cwd)
    if (decision.action === 'allow') return
    if (decision.action === 'deny') {
      return { block: true, reason: `策略拒绝：${decision.reason}（${decision.rule}）` }
    }
    return await ask(event, decision)
  }

  const gate: PolicyGate = {
    extension: (pi) => {
      pi.on('tool_call', async (event, ctx) => await handle(event, ctx.cwd))
    },
    handle,
    preset: () => preset,
    setPreset(next) {
      preset = next
    },
    bindApproval(fn) {
      approval = fn
    },
    bindSession(identity) {
      bound.add(identity.sessionId)
      gatesBySession.set(identity.sessionId, gate)
      if (identity.sessionFile !== undefined) {
        bound.add(identity.sessionFile)
        gatesBySession.set(identity.sessionFile, gate)
      }
    },
    dispose() {
      for (const key of bound) {
        if (gatesBySession.get(key) === gate) gatesBySession.delete(key)
      }
      bound.clear()
      if (o.cwd === undefined) return
      const key = path.resolve(o.cwd)
      const held = gatesByCwd.get(key)
      held?.delete(gate)
      if (held?.size === 0) gatesByCwd.delete(key)
      if (lastGate === gate) lastGate = firstGate()
    },
  }
  if (o.cwd !== undefined) {
    const key = path.resolve(o.cwd)
    const held = gatesByCwd.get(key) ?? new Set<PolicyGate>()
    held.add(gate)
    gatesByCwd.set(key, held)
    lastGate = gate
  }
  return gate
}

function firstGate(): PolicyGate | undefined {
  for (const held of gatesByCwd.values()) {
    const found = held.values().next()
    if (!found.done) return found.value
  }
  return undefined
}

/** 审批卡片上「它将要做什么」：命令或路径优先，其余给截断的 JSON。 */
function describeToolCall(event: ToolCallEvent): string {
  const input = Object.fromEntries(Object.entries(event.input))
  if (typeof input.command === 'string') return `Command: ${input.command}`
  const pathValue =
    typeof input.path === 'string'
      ? input.path
      : typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.file_path === 'string'
          ? input.file_path
          : undefined
  if (pathValue !== undefined) return `Path: ${pathValue}`
  return JSON.stringify(input).slice(0, 2000)
}
