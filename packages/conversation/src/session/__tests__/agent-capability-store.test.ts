import { describe, expect, it } from 'bun:test'
import type { AgentToolkit, SessionConfigControl } from '../../agent'

import { AgentCapabilityStore } from '../agent-capability-store'

/*
 * 每个用例造一份自己的 store，端口由 start() 交进去。
 *
 * 它不认识 React、不认识进程，也不认识 IPC，所以这里不需要任何模块级的复位动作。
 */

/* 名册不是这些用例的主角：给一个恒空的读法，让端口完整。 */
const EMPTY_TOOLKIT: AgentToolkit = { skills: [], mcpServers: [] }

const inert = (): (() => void) => () => undefined

const control = (
  id: string,
  purpose: SessionConfigControl['purpose'],
  current: string,
  values: readonly string[],
): SessionConfigControl => ({
  id,
  label: id,
  purpose,
  current,
  choices: values.map((value) => ({ value, label: value })),
})

/* 三张表。档位候选各不相同，那正是"档位随模型变"这件事本身。 */
const ON_OFF: readonly SessionConfigControl[] = [
  control('model', 'model', 'kimi-k2', ['kimi-k2', 'kimi-k3']),
  control('thought', 'thought', 'off', ['off', 'on']),
]

const THREE_TIER: readonly SessionConfigControl[] = [
  control('model', 'model', 'kimi-k3', ['kimi-k2', 'kimi-k3']),
  control('thought', 'thought', 'high', ['off', 'high', 'max']),
]

const MAXED: readonly SessionConfigControl[] = [
  control('model', 'model', 'kimi-k3', ['kimi-k2', 'kimi-k3']),
  control('thought', 'thought', 'max', ['off', 'high', 'max']),
]

/* 批准方式一格：purpose 是 permission，不是 mode —— 写错判据的那次事故就在这里。 */
const WITH_PERMISSION: readonly SessionConfigControl[] = [
  control('model', 'model', 'kimi-k2', ['kimi-k2', 'kimi-k3']),
  {
    id: 'permission',
    label: '批准方式',
    purpose: 'permission',
    current: 'manual',
    choices: [
      { value: 'manual', label: '请求批准' },
      { value: 'yolo', label: '帮我批准' },
    ],
  },
]

/* 让已经兑现的那些 then 跑完。这里没有计时器，所以不需要假时钟。 */
async function settled(): Promise<void> {
  for (let tick = 0; tick < 32; tick += 1) {
    await Promise.resolve()
  }
}

const currentOf = (table: readonly SessionConfigControl[], id: string): string | undefined =>
  table.find((offered) => offered.id === id)?.current

describe('锚会话的那张表', () => {
  it('换模型时下发的是整个控件，档位随同一次答复一起换掉', async () => {
    const store = new AgentCapabilityStore()

    let asked: SessionConfigControl | undefined

    const stop = store.start({
      read: () => Promise.resolve(ON_OFF),
      select: (control) => {
        asked = control

        return Promise.resolve(THREE_TIER)
      },
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    expect(currentOf(store.snapshot().controls, 'thought')).toBe('off')

    store.selectControl('model', 'kimi-k3')
    await settled()

    /* 一次答复整张换掉：不存在"新模型 + 旧档位"这种中间形态。 */
    expect(currentOf(store.snapshot().controls, 'model')).toBe('kimi-k3')
    expect(currentOf(store.snapshot().controls, 'thought')).toBe('high')

    /* 端口收的是控件，不是它的 id：桌面那一侧靠 purpose 认出「模型那一格」才会去
    写 default_model。传字符串过去，两处一起读出 undefined。 */
    expect(asked?.id).toBe('model')
    expect(asked?.purpose).toBe('model')

    stop()
  })

  it('agent 换完模型自己收敛一次，入口那张表跟着换掉', async () => {
    const store = new AgentCapabilityStore()

    let table: readonly SessionConfigControl[] = ON_OFF
    let announce: (() => void) | undefined

    const stop = store.start({
      read: () => Promise.resolve(table),
      select: () => Promise.resolve(table),
      subscribe: (handler) => {
        announce = handler

        return () => {
          announce = undefined
        }
      },
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    expect(currentOf(store.snapshot().controls, 'thought')).toBe('off')

    /* agent 补推了一次：屏幕必须跟着回到它真在用的那张表。 */
    table = THREE_TIER
    announce?.()

    await settled()

    expect(currentOf(store.snapshot().controls, 'thought')).toBe('high')

    stop()
  })

  it('飞在半路的旧读取不覆盖新答复', async () => {
    const store = new AgentCapabilityStore()

    let release: ((table: readonly SessionConfigControl[]) => void) | undefined
    let reads = 0

    const stop = store.start({
      read: () => {
        reads += 1

        if (reads === 1) {
          return Promise.resolve(ON_OFF)
        }

        return new Promise<readonly SessionConfigControl[]>((resolve) => {
          release = resolve
        })
      },
      select: () => Promise.resolve(THREE_TIER),
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    /* 第二次读取还在飞的时候，切换的答复先回来。 */
    store.refresh()
    store.selectControl('model', 'kimi-k3')
    await settled()

    expect(currentOf(store.snapshot().controls, 'thought')).toBe('high')

    release?.(ON_OFF)
    await settled()

    /* 该赢的是问得晚的那一个，不是回来得晚的那一个。 */
    expect(currentOf(store.snapshot().controls, 'thought')).toBe('high')

    stop()
  })

  it('agent 从没提供过的值不下发', async () => {
    const store = new AgentCapabilityStore()

    let asked = 0

    const stop = store.start({
      read: () => Promise.resolve(ON_OFF),
      select: () => {
        asked += 1

        return Promise.resolve(THREE_TIER)
      },
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    /* 这张表的档位只有 off/on：max 不属于它，发出去只会换回一个错误。 */
    store.selectControl('thought', 'max')
    await settled()

    expect(asked).toBe(0)
    expect(currentOf(store.snapshot().controls, 'thought')).toBe('off')

    stop()
  })

  it('连着改两项时，后一项的判据是前一项的答复', async () => {
    const store = new AgentCapabilityStore()

    const sent: Array<{ id: string; value: string; from: string }> = []

    let table: readonly SessionConfigControl[] = ON_OFF

    const stop = store.start({
      read: () => Promise.resolve(table),
      select: (control, value) => {
        sent.push({ id: control.id, value, from: control.current })

        table = control.id === 'model' ? THREE_TIER : MAXED

        return Promise.resolve(table)
      },
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    /*
     * 同一拍里发两次。max 只存在于换完模型之后那张表里 —— 并发下发的第二条命令
     * 读的是改动前那张，于是它会被当成"agent 从没提供过的值"静默丢掉。
     */
    store.selectControl('model', 'kimi-k3')
    store.selectControl('thought', 'max')
    await settled()

    /* 两条都发出去了，而且第二条带着的是新表里那个档位控件。 */
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual({ id: 'model', value: 'kimi-k3', from: 'kimi-k2' })
    expect(sent[1]).toEqual({ id: 'thought', value: 'max', from: 'high' })
    expect(currentOf(store.snapshot().controls, 'thought')).toBe('max')

    stop()
  })

  it('批准方式的点击落成持久意图，别的格子不落', async () => {
    const written: string[] = []

    const store = new AgentCapabilityStore({
      posture: {
        read: () => undefined,
        write: (value) => {
          written.push(value)
        },
      },
    })

    let table = WITH_PERMISSION

    const stop = store.start({
      read: () => Promise.resolve(table),
      select: (_control, value) => {
        table =
          value === 'yolo'
            ? WITH_PERMISSION.map((entry) =>
                entry.id === 'permission' ? { ...entry, current: 'yolo' } : entry,
              )
            : table

        return Promise.resolve(table)
      },
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    store.selectControl('permission', 'yolo')
    await settled()

    expect(written).toEqual(['yolo'])

    /* 模型走 agent 配置，不进批准姿态这一个持久端口。 */
    store.selectControl('model', 'kimi-k3')
    await settled()

    expect(written).toEqual(['yolo'])

    stop()
  })

  it('读不到时理由进快照，再试一次能回来', async () => {
    const store = new AgentCapabilityStore()

    let reads = 0

    const stop = store.start({
      read: () => {
        reads += 1

        return reads === 1 ? Promise.reject(new Error('agent 没起来')) : Promise.resolve(ON_OFF)
      },
      select: () => Promise.resolve(ON_OFF),
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    /*
     * 空表与失败是两种不同的画法：一个都没有时屏幕上什么都不画，而这是一次真的
     * 失败，它必须说出理由并且能被再试一次（见 agent-ui 的 session-controls.tsx）。
     */
    expect(store.snapshot().controls).toHaveLength(0)
    expect(store.snapshot().failure).toContain('agent 没起来')

    store.refresh()
    await settled()

    expect(store.snapshot().failure).toBeUndefined()
    expect(currentOf(store.snapshot().controls, 'thought')).toBe('off')

    stop()
  })
})
