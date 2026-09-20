import { describe, expect, it } from 'bun:test'
import type { SessionConfigControl } from '../../agent/config'
import type { AgentToolkit } from '../../agent/toolkit'

import { AgentCapabilityStore } from '../capability-store'

const EMPTY_TOOLKIT: AgentToolkit = { skills: [], mcpServers: [] }

const skill = (name: string, source: string): AgentToolkit['skills'][number] => ({
  id: `skill:${name}`,
  name,
  description: name,
  source,
  path: `/${name}`,
  project: null,
  projectPath: null,
  document: null,
  directory: null,
  enabled: true,
  loaded: true,
  kind: 'inline',
  disableModelInvocation: null,
  supportingFiles: null,
  totalBytes: null,
  modifiedAt: null,
})

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

    expect(currentOf(store.snapshot().controls, 'model')).toBe('kimi-k3')
    expect(currentOf(store.snapshot().controls, 'thought')).toBe('high')

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

    store.refresh()
    store.selectControl('model', 'kimi-k3')
    await settled()

    expect(currentOf(store.snapshot().controls, 'thought')).toBe('high')

    release?.(ON_OFF)
    await settled()

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

    store.selectControl('model', 'kimi-k3')
    store.selectControl('thought', 'max')
    await settled()

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

    store.selectControl('model', 'kimi-k3')
    await settled()

    expect(written).toEqual(['yolo'])

    stop()
  })

  it('内置 Skill 不进入用户可见名册', async () => {
    const store = new AgentCapabilityStore()

    const stop = store.start({
      read: () => Promise.resolve(ON_OFF),
      select: () => Promise.resolve(ON_OFF),
      subscribe: inert,
      readToolkit: () =>
        Promise.resolve({
          skills: [skill('check-kimi-code-docs', 'builtin'), skill('review', 'project')],
          mcpServers: [],
        }),
    })

    await settled()

    expect(store.snapshot().toolkit.skills.map((entry) => entry.name)).toEqual(['review'])

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

    expect(store.snapshot().controls).toHaveLength(0)
    expect(store.snapshot().failure).toContain('agent 没起来')

    store.refresh()
    await settled()

    expect(store.snapshot().failure).toBeUndefined()
    expect(currentOf(store.snapshot().controls, 'thought')).toBe('off')

    stop()
  })
})

describe('盘上那张表（上一趟 agent 确认过的）', () => {
  const memoryOf = (remembered: readonly SessionConfigControl[]) => {
    const written: Array<readonly SessionConfigControl[]> = []

    return {
      port: {
        read: () => remembered,
        write: (controls: readonly SessionConfigControl[]) => {
          written.push(controls)
        },
      },
      written,
    }
  }

  it('开窗第一帧就是完整的样子，且标成还没被确认', () => {
    const { port } = memoryOf(ON_OFF)
    const store = new AgentCapabilityStore({ memory: port })

    const held = store.snapshot()

    expect(held.controls).toBe(ON_OFF)
    expect(held.provisional).toBe(true)
  })

  it('agent 答了一次之后就不再是未确认态', async () => {
    const { port } = memoryOf(ON_OFF)
    const store = new AgentCapabilityStore({ memory: port })

    const stop = store.start({
      read: () => Promise.resolve(THREE_TIER),
      select: () => Promise.resolve(THREE_TIER),
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    expect(store.snapshot().controls).toBe(THREE_TIER)
    expect(store.snapshot().provisional).toBe(false)

    stop()
  })

  it('未确认期间下发被拦住，确认之后照常下发', async () => {
    const { port } = memoryOf(ON_OFF)
    const store = new AgentCapabilityStore({ memory: port })

    let asked = 0
    let release: ((table: readonly SessionConfigControl[]) => void) | undefined

    const stop = store.start({
      read: () =>
        new Promise<readonly SessionConfigControl[]>((resolve) => {
          release = resolve
        }),
      select: () => {
        asked += 1

        return Promise.resolve(THREE_TIER)
      },
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    store.selectControl('model', 'kimi-k3')
    await settled()

    expect(asked).toBe(0)

    release?.(ON_OFF)
    await settled()

    store.selectControl('model', 'kimi-k3')
    await settled()

    expect(asked).toBe(1)

    stop()
  })

  it('agent 确认过的那张表落成下一趟的第一帧', async () => {
    const { port, written } = memoryOf([])
    const store = new AgentCapabilityStore({ memory: port })

    const stop = store.start({
      read: () => Promise.resolve(ON_OFF),
      select: () => Promise.resolve(THREE_TIER),
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    expect(written).toEqual([ON_OFF])

    store.selectControl('model', 'kimi-k3')
    await settled()

    expect(written).toEqual([ON_OFF, THREE_TIER])

    stop()
  })

  it('盘上那份读不出来时第一帧照旧空白，不抛', () => {
    const store = new AgentCapabilityStore({
      memory: {
        read: () => {
          throw new Error('存坏了')
        },
        write: () => undefined,
      },
    })

    expect(store.snapshot().controls).toEqual([])
    expect(store.snapshot().provisional).toBe(false)
  })
})

describe('补发批准方式的那一趟', () => {
  const OFFERED: readonly SessionConfigControl[] = [
    control('model', 'model', 'kimi-k2', ['kimi-k2', 'kimi-k3']),
    {
      id: 'permission',
      label: '批准方式',
      purpose: 'permission',
      current: 'manual',
      choices: [
        { value: 'manual', label: '请求批准' },
        { value: 'yolo', label: '帮我批准' },
        { value: 'auto', label: '完全访问权限' },
      ],
    },
  ]

  const ALIGNED: readonly SessionConfigControl[] = OFFERED.map((entry) =>
    entry.id === 'permission' ? { ...entry, current: 'auto' } : entry,
  )

  const postureOf = (value: string) => ({ read: () => value, write: () => undefined })

  it('中间那一档不上屏，补发照样发得出去', async () => {
    const memory: Array<readonly SessionConfigControl[]> = []
    const store = new AgentCapabilityStore({
      memory: {
        read: () => [],
        write: (controls) => {
          memory.push(controls)
        },
      },
      posture: postureOf('auto'),
    })

    const painted: Array<string | undefined> = []
    store.subscribe(() => {
      painted.push(currentOf(store.snapshot().controls, 'permission'))
    })

    const sent: string[] = []
    const stop = store.start({
      read: () => Promise.resolve(OFFERED),
      select: (_control, value) => {
        sent.push(value)

        return Promise.resolve(ALIGNED)
      },
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    expect(painted).not.toContain('manual')
    expect(painted).toContain('auto')
    /* 同值早退必须判 agent 的原话；判屏幕上投影过的表会把这次下发吞掉。 */
    expect(sent).toEqual(['auto'])
    expect(memory).toContainEqual(ALIGNED)
    expect(memory).not.toContainEqual(OFFERED)

    stop()
  })

  it('agent 拒了之后画的是它报的那一档，且不会再发第二遍', async () => {
    const store = new AgentCapabilityStore({ posture: postureOf('auto') })

    const sent: string[] = []
    const stop = store.start({
      read: () => Promise.resolve(OFFERED),
      select: (_control, value) => {
        sent.push(value)

        return Promise.resolve(OFFERED)
      },
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    expect(sent).toEqual(['auto'])
    expect(currentOf(store.snapshot().controls, 'permission')).toBe('manual')

    store.refresh()
    await settled()

    expect(sent).toEqual(['auto'])

    stop()
  })

  it('用户没选过批准方式时，agent 报什么就画什么', async () => {
    const store = new AgentCapabilityStore({ posture: postureOf('auto') })

    let sent = 0
    const stop = store.start({
      read: () => Promise.resolve(ON_OFF),
      select: () => {
        sent += 1

        return Promise.resolve(ON_OFF)
      },
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })

    await settled()

    expect(sent).toBe(0)
    expect(currentOf(store.snapshot().controls, 'permission')).toBeUndefined()

    stop()
  })
})

describe('capability binding ownership', () => {
  it('restarting the same port invalidates previous reads and cleanup', async () => {
    let release: ((table: readonly SessionConfigControl[]) => void) | undefined
    let reads = 0
    let subscriptions = 0
    const port = {
      read: () =>
        ++reads === 1
          ? new Promise<readonly SessionConfigControl[]>((resolve) => {
              release = resolve
            })
          : Promise.resolve(ON_OFF),
      select: () => Promise.resolve(ON_OFF),
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
      subscribe: () => {
        subscriptions += 1
        return () => {
          subscriptions -= 1
        }
      },
    }
    const store = new AgentCapabilityStore()
    const firstStop = store.start(port)
    const stop = store.start(port)
    firstStop()
    await settled()
    release?.(THREE_TIER)
    await settled()
    expect(currentOf(store.snapshot().controls, 'model')).toBe('kimi-k2')
    expect(subscriptions).toBe(1)
    stop()
    expect(subscriptions).toBe(0)
  })
  it('stale read and toolkit failures cannot report into a restarted binding', async () => {
    let rejectRead: ((cause: unknown) => void) | undefined
    let rejectToolkit: ((cause: unknown) => void) | undefined
    let reads = 0
    let toolkits = 0
    const reported: unknown[] = []
    const store = new AgentCapabilityStore({
      report: {
        readFailed: (cause) => {
          reported.push(cause)
        },
        changeFailed: (cause) => {
          reported.push(cause)
        },
      },
    })
    const port = {
      read: () =>
        ++reads === 1
          ? new Promise<readonly SessionConfigControl[]>((_resolve, reject) => {
              rejectRead = reject
            })
          : Promise.resolve(ON_OFF),
      select: () => Promise.resolve(ON_OFF),
      subscribe: inert,
      readToolkit: () =>
        ++toolkits === 1
          ? new Promise<AgentToolkit>((_resolve, reject) => {
              rejectToolkit = reject
            })
          : Promise.resolve(EMPTY_TOOLKIT),
    }
    store.start(port)
    const stop = store.start(port)
    await settled()
    const snapshot = store.snapshot()
    rejectRead?.(new Error('retired read'))
    rejectToolkit?.(new Error('retired toolkit'))
    await settled()
    expect(store.snapshot()).toBe(snapshot)
    expect(reported).toEqual([])
    stop()
  })
  it('a failed superseded read cannot overwrite a successful selection', async () => {
    let rejectRead: ((cause: unknown) => void) | undefined
    let reads = 0
    const store = new AgentCapabilityStore()
    const stop = store.start({
      read: () =>
        ++reads === 1
          ? Promise.resolve(ON_OFF)
          : new Promise<readonly SessionConfigControl[]>((_resolve, reject) => {
              rejectRead = reject
            }),
      select: () => Promise.resolve(THREE_TIER),
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })
    await settled()
    store.refresh()
    store.selectControl('model', 'kimi-k3')
    await settled()
    rejectRead?.(new Error('superseded read'))
    await settled()
    expect(store.snapshot().failure).toBeUndefined()
    expect(currentOf(store.snapshot().controls, 'model')).toBe('kimi-k3')
    stop()
  })
  it('a retired selection cannot initiate recovery on the next binding', async () => {
    let rejectSelection: ((cause: unknown) => void) | undefined
    let reads = 0
    const reported: unknown[] = []
    const store = new AgentCapabilityStore({
      report: {
        readFailed: (cause) => {
          reported.push(cause)
        },
        changeFailed: (cause) => {
          reported.push(cause)
        },
      },
    })
    const port = {
      read: () => {
        reads += 1
        return Promise.resolve(ON_OFF)
      },
      select: () =>
        new Promise<readonly SessionConfigControl[]>((_resolve, reject) => {
          rejectSelection = reject
        }),
      subscribe: inert,
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    }
    store.start(port)
    await settled()
    store.selectControl('model', 'kimi-k3')
    await settled()
    const stop = store.start(port)
    await settled()
    const expectedReads = reads
    const snapshot = store.snapshot()
    rejectSelection?.(new Error('retired selection'))
    await settled()
    expect(reads).toBe(expectedReads)
    expect(store.snapshot()).toBe(snapshot)
    expect(reported).toEqual([])
    stop()
  })
  it('cleanup failure still invalidates pending writes', async () => {
    let rejectRead: ((cause: unknown) => void) | undefined
    const reported: unknown[] = []
    const store = new AgentCapabilityStore({
      report: {
        readFailed: (cause) => {
          reported.push(cause)
        },
        changeFailed: (cause) => {
          reported.push(cause)
        },
      },
    })
    const stop = store.start({
      read: () =>
        new Promise<readonly SessionConfigControl[]>((_resolve, reject) => {
          rejectRead = reject
        }),
      select: () => Promise.resolve(ON_OFF),
      subscribe: () => () => {
        throw new Error('unsubscribe failed')
      },
      readToolkit: () => Promise.resolve(EMPTY_TOOLKIT),
    })
    await settled()
    expect(stop).toThrow('unsubscribe failed')
    const snapshot = store.snapshot()
    rejectRead?.(new Error('retired read'))
    await settled()
    expect(store.snapshot()).toBe(snapshot)
    expect(reported).toEqual([])
    expect(stop).not.toThrow()
  })
})
