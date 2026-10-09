import { describe, expect, test } from 'bun:test'
import { createPostureIntent } from '../posture-intent'

/*
 * 真实故障：批准方式**不持久**——在入口页选一次完全访问，切走页面或重启软件又回到默认档。
 *
 * 根因是这一格从来没有落盘的地方：legacy 把用户按下那一档写进一条客户端偏好
 * （`poietica.permission-posture`），新架构里它对应 preferences 的 uiState
 * `'conversation.permissionPosture'`。这台 intent 就是那条记忆的正主，判据有三条：
 *
 *   1. `read()` **同步**答得出来（两台 store 在 agent 答复落地那一刻要它判补发）；
 *   2. `write()` 先改内存、再异步落盘（失手不拖垮这一趟）；
 *   3. `load()` 开机读一次盘，读回来才换内存那一份。
 */

/** 一片可控的盘：读写各记一笔，交回什么由用例指定。 */
interface FakeDisk {
  readonly written: string[]
  reads: number
  value: unknown
  readonly read: () => Promise<unknown>
  readonly write: (value: string) => Promise<void>
}

function fakeDisk(initial: unknown): FakeDisk {
  const disk: FakeDisk = {
    value: initial,
    written: [],
    reads: 0,
    read: async () => {
      disk.reads += 1
      return disk.value
    },
    write: async (value: string) => {
      disk.written.push(value)
      disk.value = value
    },
  }
  return disk
}

describe('批准方式的持久意图', () => {
  test('没有意图时 read() 是 undefined（第一帧就是默认档）', () => {
    const disk = fakeDisk(undefined)
    const intent = createPostureIntent({ read: disk.read, write: disk.write })

    expect(intent.read()).toBeUndefined()
    expect(disk.reads).toBe(0)
  })

  test('load() 把盘上那一份读进内存（重启后仍记得）', async () => {
    const disk = fakeDisk('auto')
    const intent = createPostureIntent({ read: disk.read, write: disk.write })

    await intent.load()

    expect(intent.read()).toBe('auto')
    expect(disk.reads).toBe(1)
  })

  test('load() 只认非空字符串：空串与别的类型按「没有意图」处置', async () => {
    for (const stored of ['', 42, null] as const) {
      const intent = createPostureIntent({ read: async () => stored, write: async () => undefined })
      await intent.load()
      expect(intent.read()).toBeUndefined()
    }
  })

  test('write() 先改内存、再异步落盘（同一趟立刻读得到）', async () => {
    const disk = fakeDisk(undefined)
    const intent = createPostureIntent({ read: disk.read, write: disk.write })

    intent.write('auto')

    /* 顺序是这一条的全部：同步这一格必须先换，异步那一段只是补记。 */
    expect(intent.read()).toBe('auto')
    expect(disk.written).toEqual(['auto'])
  })

  test('write() 同一个值不重复落盘（早退，不刷新订阅者）', () => {
    const disk = fakeDisk(undefined)
    const intent = createPostureIntent({ read: disk.read, write: disk.write })
    let notified = 0
    intent.subscribe(() => {
      notified += 1
    })

    intent.write('yolo')
    intent.write('yolo')

    expect(disk.written).toEqual(['yolo'])
    expect(notified).toBe(1)
  })

  test('write() 之后 load() 不会把用户刚按下的那一档冲掉', async () => {
    const disk = fakeDisk('manual')
    const intent = createPostureIntent({ read: disk.read, write: disk.write })

    intent.write('auto')
    await intent.load()

    /* 盘上那份与内存同值才换；先写后读这一趟读到的还是刚写的那一个。 */
    expect(intent.read()).toBe('auto')
  })

  test('订阅者收到每一次真的变化（入口页那一格据此换初始值）', () => {
    const disk = fakeDisk(undefined)
    const intent = createPostureIntent({ read: disk.read, write: disk.write })
    const seen: (string | undefined)[] = []
    const stop = intent.subscribe(() => {
      seen.push(intent.read())
    })

    intent.write('auto')
    intent.write('manual')
    stop()
    intent.write('yolo')

    expect(seen).toEqual(['auto', 'manual'])
  })

  test('读写失败只上报、不抛（记忆坏了不该把界面拖崩）', async () => {
    const reported: unknown[] = []
    const intent = createPostureIntent({
      read: async () => {
        throw new Error('disk busy')
      },
      write: async () => {
        throw new Error('disk full')
      },
      report: (cause) => {
        reported.push(cause)
      },
    })

    await intent.load()
    expect(intent.read()).toBeUndefined()

    intent.write('auto')
    /* 落盘是异步的，等它那一转失败上报。 */
    await Promise.resolve()
    await Promise.resolve()

    expect(intent.read()).toBe('auto')
    expect(reported.length).toBe(2)
  })
})
