/*
 * 技能轮在屏幕上的三格事实。三条都是同一条链上**静默**坏掉过的，所以各钉一条：
 *
 *   1. chip 在轮终之后还在（重投影不许把 origin 写成光秃秃的 {kind:'user'}）；
 *   2. SKILL.md 的整份正文**不上屏**（它不是这一轮的助手正文）；
 *   3. 用户自己那句话进得了模型上下文（`{{userArgs}}` 那一格不许是空的）。
 *
 * 技能以 `role: 'custom'` + `customType: 'skill-prompt'` + `attribution: 'user'` 进显示经过，
 * 判定用官方那一条（pi-tui 的 isUserTurnInitiator）；chip 的名字与人的原话都在官方消息自己的
 * `details` 上（SkillPromptDetails：name / path / args / prompt / lineCount）。
 *
 * 跑法：cd packages/agent-bridge && bun test src/__tests__/skill-turn.test.ts
 *
 * 拦的是 SDK 原型上的那一动（同 interjection-layers.test.ts 的做法）：这里要证的是「桥把
 * 哪一格读成什么」，真起一轮要模型与密钥，那是另一个测试的事。
 */

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentSessionEvent } from '@oh-my-pi/pi-coding-agent'
import { AgentSession, createBridge, home, SessionManager } from './sdk-home.ts'

const SKILL_NAME = 'ponytail'
const SPOKEN = '清理冗余代码'
const SKILL_BODY =
  '[IMPORTANT: User invoked the "ponytail" skill; follow its instructions. Full skill below.]'

/* 技能真的住在盘上：展开那条路调官方的 buildSkillPromptMessage，它要读 SKILL.md。 */
const skillsRoot = mkdtempSync(path.join(tmpdir(), 'poietica-skill-'))
const skillFile = path.join(skillsRoot, SKILL_NAME, 'SKILL.md')
mkdirSync(path.dirname(skillFile), { recursive: true })
writeFileSync(
  skillFile,
  `---
name: ${SKILL_NAME}
description: 偷懒哲学
---

${SKILL_BODY}

你是偷懒的资深开发者。
`,
)

/* 显示经过里那一条技能消息：形状照 buildSkillPromptMessage 交回的那一份。 */
const skillMessage = {
  role: 'custom',
  customType: 'skill-prompt',
  attribution: 'user',
  display: true,
  content: [{ type: 'text', text: `${SKILL_BODY}\n\n你是偷懒的资深开发者。` }],
  details: {
    name: SKILL_NAME,
    path: 'C:/skills/ponytail/SKILL.md',
    args: SPOKEN,
    prompt: SPOKEN,
    lineCount: 3,
  },
  timestamp: 1_000,
}

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: '做完了' }],
  stopReason: 'stop',
  timestamp: 2_000,
}

/* 显示经过：技能那条开场，后面跟一趟助手正文。 */
const transcriptMessages: readonly unknown[] = [skillMessage, assistantMessage]

const saved = new Map<string, PropertyDescriptor | undefined>()
function override(key: string, descriptor: PropertyDescriptor): void {
  saved.set(key, Object.getOwnPropertyDescriptor(AgentSession.prototype, key))
  Object.defineProperty(AgentSession.prototype, key, { configurable: true, ...descriptor })
}

/* 会话自己的技能表：expandSkills 按名字在这里查。 */
override('skills', {
  get: () => [
    {
      name: SKILL_NAME,
      description: '偷懒哲学',
      filePath: skillFile,
      baseDir: path.dirname(skillFile),
      source: 'test',
    },
  ],
})

override('prompt', { value: async () => true })

/** 技能那条路的投递口：把交上来的消息留一份，测试要读它。 */
interface DeliveredSkillMessage {
  readonly content?: unknown
  readonly customType?: string
  readonly details?: unknown
}
let deliveredMessage: DeliveredSkillMessage | null = null
/*
 * 经函数读回来，不直接读那个 let：赋值发生在回调里，TS 的控制流分析看不见它，
 * 会把变量收窄成初始的 null，读出来的类型就成了 never。
 */
const delivered = (): DeliveredSkillMessage | null => deliveredMessage
override('promptCustomMessage', {
  value: async function (this: unknown, message: unknown) {
    deliveredMessage = message as DeliveredSkillMessage
    return true
  },
})

override('getQueuedMessages', { value: () => ({ steering: [], followUp: [] }) })
override('getLastAssistantMessage', { value: () => assistantMessage })

const listeners: ((event: AgentSessionEvent) => void)[] = []
override('subscribe', {
  value: (listener: (event: AgentSessionEvent) => void) => {
    listeners.push(listener)
    return () => undefined
  },
})

for (const key of ['steeringMode', 'followUpMode', 'interruptMode'] as const) {
  override(key, { get: () => 'one-at-a-time' })
}

/*
 * 显示经过由桥经 `sessionManager.buildSessionContext` 读，所以夹具打在 SessionManager 的原型上：
 * 真起一条会话要模型与密钥，而这里要证的只是「桥把哪一格读成什么」。
 */
const savedManager = new Map<string, PropertyDescriptor | undefined>()
function overrideManager(key: string, descriptor: PropertyDescriptor): void {
  savedManager.set(key, Object.getOwnPropertyDescriptor(SessionManager.prototype, key))
  Object.defineProperty(SessionManager.prototype, key, { configurable: true, ...descriptor })
}

/*
 * 只换**显示经过**那一次读（桥传 `transcript: true`）。其余调用原样交给真实现 ——
 * omp 自己在建档时也要读一次会话上下文，把它一起换掉就是拿夹具去砸 SDK 的初始化。
 */
const realBuildSessionContext = SessionManager.prototype.buildSessionContext
overrideManager('buildSessionContext', {
  value: function (this: unknown, options?: { readonly transcript?: boolean }) {
    return options?.transcript === true
      ? { messages: transcriptMessages }
      : realBuildSessionContext.call(this, options as never)
  },
})

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(AgentSession.prototype, key)
    } else {
      Object.defineProperty(AgentSession.prototype, key, descriptor)
    }
  }
  for (const [key, descriptor] of savedManager) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(SessionManager.prototype, key)
    } else {
      Object.defineProperty(SessionManager.prototype, key, descriptor)
    }
  }
})

const bridge = createBridge({ agentDir: home, cwd: process.cwd() })

const ops: {
  op: string
  turn?: { origin?: unknown; prompt?: string }
  frame?: { role?: string; text?: string }
}[] = []
bridge.subscribe((event) => {
  if (event.kind === 'transcript') {
    const frame = event.payload as { payload?: { ops?: typeof ops } }
    ops.push(...(frame.payload?.ops ?? []))
  }
})

await bridge.dispatch({ id: 'open', type: 'new_session', cwd: process.cwd() } as never)

let serial = 0
async function dispatch(command: Record<string, unknown>): Promise<unknown> {
  serial += 1
  return bridge.dispatch({ id: `cmd-${String(serial)}`, ...command } as never)
}

test('一条挂了技能的提交把展开后的消息投给 agent，并把人的话当 args 带上', async () => {
  deliveredMessage = null
  await dispatch({
    id: 'skill-1',
    type: 'prompt',
    text: SPOKEN,
    promptId: 'p-skill-1',
    deliverAs: 'turn',
    attachments: [],
    skills: [{ name: SKILL_NAME }],
  })

  /* 走的是官方那条路：customMessage 的 customType 是 skill-prompt。 */
  expect(delivered()?.customType).toBe('skill-prompt')

  /*
   * 人的原话必须在消息正文里 —— 它就是官方模板的 `{{userArgs}}`。
   * 从前这里传的是 chip 上那格 args（调色板插的 chip 没有 args），整段被省掉，
   * 模型收到的只有技能正文。
   */
  const held = delivered()
  const text = Array.isArray(held?.content)
    ? (held.content as { type?: string; text?: string }[])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
    : String(held?.content ?? '')

  expect(text).toContain(SPOKEN)
})

test('重投影之后技能那一轮带着 chip，而不是光秃秃的 user origin', async () => {
  ops.length = 0

  /* 轮终：桥会拿显示经过对一遍屏幕（repaintScreen → syncScreen → turnOp）。 */
  for (const listener of listeners) {
    listener({ type: 'agent_end', messages: [], isTerminal: true } as AgentSessionEvent)
  }
  await Bun.sleep(60)

  const turns = ops.filter((op) => op.op === 'turn.upsert')
  expect(turns.length).toBeGreaterThan(0)

  /*
   * chip 的真产地：origin.payload.skillActivations（transcript-projector 的
   * skillNamesOf 只读它）。写成 {kind:'user'} 就没有 chip —— 那正是用户看到
   * 「发出去还有、一轮跑完就没了」的原因。
   */
  const carried = turns.some(
    (op) =>
      JSON.stringify(op.turn?.origin ?? {}).includes('skillActivations') &&
      JSON.stringify(op.turn?.origin ?? {}).includes(SKILL_NAME),
  )
  expect(carried).toBe(true)

  /* 人那句话也要落回这一轮：entry.prompt 从前是 null，屏幕上连问了什么都看不见。 */
  expect(turns.some((op) => op.turn?.prompt === SPOKEN)).toBe(true)
})

test('技能轮的正文不是这一轮的助手正文 —— 整份 SKILL.md 不上屏', async () => {
  const assistantTexts = ops
    .filter((op) => op.frame?.role === 'assistant')
    .map((op) => op.frame?.text ?? '')

  /* 助手那一趟照常画。 */
  expect(assistantTexts).toContain('做完了')
  /* 技能正文一个字都不许当助手正文画出来。 */
  for (const text of assistantTexts) {
    expect(text).not.toContain('User invoked the')
  }
})
