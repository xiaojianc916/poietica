/*
 * 三层插话的投递路由。
 *
 * 这条路的缺口是一整条：`deliverAs` 之前根本不存在，而唯一那条 `steer` 命令把
 * **prompt 号**当正文发进插话队列（`prompt_ids.join("\n")`），三层里一层都没真的用上。
 * 这个文件逐条钉住现在的路由：
 *
 *   1. `steer`   → `AgentSession.steer(text, images)`（工具批次之间被模型看到）；
 *   2. `followUp`→ `AgentSession.followUp(...)`（本轮跑完接着做）；
 *   3. `aside`   → `sendUserMessage(content, {deliverAs:'aside'})`（step 边界静默注入）；
 *   4. `turn`    → `prompt(...)`，一格都不带 `deliverAs` 那套；
 *   5. `queue` / `withdraw` / `delivery` 三条读改写都落到 agent 自己的读法上。
 *
 * 跑法：cd packages/agent-bridge && bun test src/__tests__/interjection-layers.test.ts
 *
 * 拦的是 SDK 原型上的那一动（同 live-image-attachments.test.ts 的做法）：真起一轮要模型
 * 与密钥，那是另一个测试的事；这里要证的是「桥把哪一层交给了哪一个方法」。
 */

import { afterAll, expect, test } from 'bun:test'
import type { AgentSessionEvent } from '@oh-my-pi/pi-coding-agent'
import { AgentSession, createBridge, home } from './sdk-home.ts'

interface Call {
  readonly how: string
  readonly text: string
  readonly images: readonly unknown[]
}

const calls: Call[] = []
const modes = {
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  interruptMode: 'immediate',
}
const queued = { steering: ['插一句'], followUp: ['排队的一句'] }
let withdrawn: string | undefined = '排队的一句'

const saved = new Map<string, PropertyDescriptor | undefined>()
function override(key: string, descriptor: PropertyDescriptor): void {
  saved.set(key, Object.getOwnPropertyDescriptor(AgentSession.prototype, key))
  Object.defineProperty(AgentSession.prototype, key, { configurable: true, ...descriptor })
}

const record = (how: string) =>
  async function (this: unknown, text: string, images?: readonly unknown[]): Promise<void> {
    calls.push({ how, text, images: images ?? [] })
  }

override('prompt', {
  value: async function (this: unknown, text: string, options?: { images?: readonly unknown[] }) {
    calls.push({ how: 'turn', text, images: options?.images ?? [] })
    return true
  },
})
override('steer', { value: record('steer') })
override('followUp', { value: record('followUp') })
override('sendUserMessage', {
  value: async function (this: unknown, content: unknown, options?: { deliverAs?: string }) {
    const text = typeof content === 'string' ? content : String(Array.isArray(content) ? '' : '')
    calls.push({ how: `aside:${options?.deliverAs ?? 'none'}`, text, images: [] })
  },
})
override('getQueuedMessages', { value: () => queued })
/* 轮终那一格要用：桥按 agent 自己报的最后一条助手消息判结局。 */
override('getLastAssistantMessage', {
  value: () => ({
    content: [{ type: 'text', text: '做完了' }],
    role: 'assistant',
    stopReason: 'stop',
  }),
})
/*
 * 事件洪流抓在手里：真实那一份由 agent loop 喂，这里要手动放帧。
 * 形状用 SDK 自己的 `AgentSessionEvent`，不另立一份 —— 帧一变形，这里就该编译失败。
 */
const listeners: ((event: AgentSessionEvent) => void)[] = []
override('subscribe', {
  value: (listener: (event: AgentSessionEvent) => void) => {
    listeners.push(listener)
    return () => undefined
  },
})
/** 把一帧交给桥。真实那一份由 agent loop 推，这里只放我们关心的那两种。 */
function feed(event: AgentSessionEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}
override('popLastQueuedMessage', {
  value: () => (withdrawn === undefined ? undefined : { text: withdrawn }),
})
override('setSteeringMode', {
  value: (mode: string) => {
    modes.steeringMode = mode
  },
})
override('setFollowUpMode', {
  value: (mode: string) => {
    modes.followUpMode = mode
  },
})
override('setInterruptMode', {
  value: (mode: string) => {
    modes.interruptMode = mode
  },
})
for (const key of ['steeringMode', 'followUpMode', 'interruptMode'] as const) {
  override(key, { get: () => modes[key] })
}

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(AgentSession.prototype, key)
    } else {
      Object.defineProperty(AgentSession.prototype, key, descriptor)
    }
  }
  /*
   * 临时 home 里的 agent.db 还开着（SQLite 句柄），Windows 上删不动；删不掉不是测试的
   * 事实，交给系统清临时目录。归属在 sdk-home.ts 一处，别的文件还在用它。
   */
})

const bridge = createBridge({ agentDir: home, cwd: process.cwd() })

let serial = 0
/** 一条命令一个号；应答原样交回，失败就抛（测试要看得见）。 */
async function dispatch(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  calls.length = 0
  serial += 1
  return (await bridge.dispatch({
    id: `cmd-${String(serial)}`,
    ...command,
  } as never)) as Record<string, unknown>
}

await bridge.dispatch({ id: 'open', type: 'new_session', cwd: process.cwd() } as never)

const layer = (deliverAs: string) => ({
  id: `layer-${deliverAs}`,
  type: 'prompt',
  text: `一句${deliverAs}`,
  promptId: `p-${deliverAs}`,
  deliverAs,
  attachments: [],
  skills: [],
})

test('steer lands on the steering queue, not on a turn', async () => {
  await dispatch(layer('steer'))
  expect(calls.map((call) => call.how)).toEqual(['steer'])
  expect(calls[0]?.text).toBe('一句steer')
})

test('followUp lands on the follow-up queue', async () => {
  await dispatch(layer('followUp'))
  expect(calls.map((call) => call.how)).toEqual(['followUp'])
})

test('aside goes through sendUserMessage with the non-interrupting behavior', async () => {
  await dispatch(layer('aside'))
  expect(calls.map((call) => call.how)).toEqual(['aside:aside'])
})

test('turn opens a real turn and never steals an interjection layer', async () => {
  await dispatch(layer('turn'))
  expect(calls.map((call) => call.how)).toEqual(['turn'])
})

test('the queue is the agent’s, and the modes round-trip through it', async () => {
  const read = await dispatch({ type: 'queue' })
  expect(read['queue']).toEqual({
    sessionId: expect.any(String),
    steering: ['插一句'],
    followUp: ['排队的一句'],
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    interruptMode: 'immediate',
  })

  const changed = await dispatch({
    type: 'delivery',
    steeringMode: 'all',
    interruptMode: 'wait',
  })
  expect(changed['queue']).toMatchObject({ steeringMode: 'all', interruptMode: 'wait' })
  expect(modes.steeringMode).toBe('all')
  /* 缺席的格不改：followUpMode 没交上去，它就还是原样。 */
  expect(modes.followUpMode).toBe('one-at-a-time')
})

test('withdraw hands back the last queued text, and an empty queue is null', async () => {
  const restored = await dispatch({ type: 'withdraw' })
  expect(restored['message']).toEqual({ text: '排队的一句' })

  withdrawn = undefined
  const empty = await dispatch({ type: 'withdraw' })
  expect(empty['message']).toBeNull()
})

/*
 * 还排着队的插话要跨过轮终活着。
 *
 * 外部 abort 与「人按过停止」都刻意不排空队列，那句话等下一次显式提交才被注入 ——
 * 轮终清掉它，`message_start` 到的时候就没有认领对象，屏幕上那句话再也画不出来。
 */
test('an interjection still queued survives the turn end, and is claimed later', async () => {
  const ops: { op: string; frame?: { role?: string; text?: string } }[] = []
  const off = bridge.subscribe((event) => {
    if (event.kind === 'transcript') {
      const frame = event.payload as { payload?: { ops?: typeof ops } }
      ops.push(...(frame.payload?.ops ?? []))
    }
  })

  await dispatch(layer('followUp'))
  expect(calls.map((call) => call.how)).toEqual(['followUp'])

  /* 轮终：这句话还在 agent 的队列里（`queued.followUp` 那一格就是它的正文）。 */
  queued.followUp.push('一句followUp')
  feed({ type: 'agent_end', messages: [], isTerminal: true } as AgentSessionEvent)

  ops.length = 0
  /* 下一轮的开场：模型真的折进了这句话。 */
  feed({
    type: 'message_start',
    message: { role: 'user', content: '一句followUp', timestamp: 1 },
  } as AgentSessionEvent)
  /* 攒批窗口 16ms：正文帧不即时发，等它落地。 */
  await Bun.sleep(40)

  /* 认领到了：它被画成一句话，而不是消失在轮终。 */
  expect(ops.some((op) => op.frame?.role === 'user' && op.frame.text === '一句followUp')).toBe(true)
  queued.followUp.pop()
  off()
})

/*
 * 已经不在队列里的插话，轮终就是它的终点。
 *
 * 它要么被模型吃过、要么被用户撤回；留着一份只会让下一轮的开场白被错认成插话。
 */
test('an interjection no longer queued is forgotten at the turn end', async () => {
  const ops: { op: string; frame?: { role?: string; text?: string } }[] = []
  const off = bridge.subscribe((event) => {
    if (event.kind === 'transcript') {
      const frame = event.payload as { payload?: { ops?: typeof ops } }
      ops.push(...(frame.payload?.ops ?? []))
    }
  })

  await dispatch(layer('steer'))
  /* 撤回掉：它已经不在 agent 的队列里了。 */
  const held = queued.steering.indexOf('一句steer')
  if (held >= 0) {
    queued.steering.splice(held, 1)
  }
  feed({ type: 'agent_end', messages: [], isTerminal: true } as AgentSessionEvent)

  ops.length = 0
  feed({
    type: 'message_start',
    message: { role: 'user', content: '一句steer', timestamp: 1 },
  } as AgentSessionEvent)
  await Bun.sleep(40)

  /* 认不出来了：宁可少画一条，也不把无人认领的正文当插话画上去。 */
  expect(ops.some((op) => op.frame?.text === '一句steer')).toBe(false)
  off()
})

/*
 * 取消**不排空** steering 队列：那句话留到 post-abort 的 continue 才被注入。
 *
 * 上游 abort 刻意不动 steering 队列（agent-loop.ts:1637-1643），所以取消这一刻把它从
 * 认领账本里摘掉，就等于那句人已经写好的话再也画不出来 —— 而它明明还在队列里等着。
 */
test('an abort keeps a still-queued steer claimable', async () => {
  const ops: { op: string; frame?: { role?: string; text?: string } }[] = []
  const off = bridge.subscribe((event) => {
    if (event.kind === 'transcript') {
      const frame = event.payload as { payload?: { ops?: typeof ops } }
      ops.push(...(frame.payload?.ops ?? []))
    }
  })

  await dispatch(layer('steer'))
  /* 真 agent 会把它排进 steering 队列（这里的队列是死夹具，手动补上）。 */
  queued.steering.push('一句steer')
  /* 取消：队列照旧留着它（上游的既定语义），认领账本也就得留着。 */
  await dispatch({ type: 'cancel' })

  ops.length = 0
  feed({
    type: 'message_start',
    message: { role: 'user', content: '一句steer', timestamp: 1 },
  } as AgentSessionEvent)
  await Bun.sleep(40)

  /* post-abort 的 continue 把它折进上下文：认得出来，画得出来。 */
  expect(ops.some((op) => op.frame?.role === 'user' && op.frame.text === '一句steer')).toBe(true)
  off()
})
