import { describe, expect, test } from 'bun:test'
import type { Thread } from '../../../contract'
import type { AgentPromptHandle, AgentPromptRequest, AgentSessionPort, QueuedMessages } from '../../agent/session'
import type { TranscriptPage } from '../../agent/transcript'
import { createSessionRegistry } from '../../stores/session-registry'
import { createThreadEntry } from '../../stores/thread-entry'
import { TranscriptStore } from '../transcript-store'

/*
 * 会话接线的四条回归（真实故障「这个界面还没有接上助手会话。」的守卫）。
 *
 * 四条都盯着同一类错误：**端口这一层的身份与生命周期**。它们是纯 store/状态机，
 * 不需要渲染树 —— 判据写在这里，组件只负责把它们接起来。
 */

const EMPTY_PAGE: TranscriptPage = {
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
  agentId: 'main',
  agents: [],
  pendingInteractions: [],
  seq: 1,
} as unknown as TranscriptPage

const EMPTY_QUEUE: QueuedMessages = {
  threadId: '',
  steering: [],
  followUp: [],
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  interruptMode: 'immediate',
}

/**
 * 一根记账用的假端口。
 *
 * `active` 是它此刻还活着的订阅数（订阅加一、退订减一）——第 3、4 条判据量它。
 */
function fakePort(threadId: string) {
  const state = { active: 0, opened: 0, prompts: [] as string[] }
  const track = () => {
    state.active += 1
    return () => {
      state.active -= 1
    }
  }
  const port: AgentSessionPort = {
    transcript: {
      subscribeTranscript: () => track(),
      readTranscript: async () => EMPTY_PAGE,
      catchUpTranscript: async (_sessionId, agentId, sinceSeq) => ({
        agentId,
        batches: [],
        latestSeq: sinceSeq,
        complete: true,
      }),
    },
    prompt: async (request: AgentPromptRequest): Promise<AgentPromptHandle> => {
      state.prompts.push(request.text)
      return { sessionId: threadId, promptId: `p${String(state.prompts.length)}` }
    },
    cancel: async () => undefined,
    readQueue: async () => ({ ...EMPTY_QUEUE, threadId }),
    withdraw: async () => null,
    move: async () => ({ ...EMPTY_QUEUE, threadId }),
    setDeliveryModes: async () => ({ ...EMPTY_QUEUE, threadId }),
    subscribeQueue: () => track(),
    subscribePromptDropped: () => track(),
    subscribeRunFailed: () => track(),
    abortPrompt: async () => undefined,
    resolvePermission: async () => undefined,
    resolvePlan: async () => undefined,
    answerQuestions: async () => undefined,
    dismissQuestions: async () => undefined,
  }
  return { port, state }
}

function thread(id: string): Thread {
  return {
    id,
    workspaceId: 'w1',
    title: '新对话',
    titleSource: 'pending',
    posture: 'auto-edit',
    origin: 'user',
    state: 'idle',
    hasSession: false,
    forkedFrom: null,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

const submit = (text: string) => ({
  assets: [],
  configuration: [],
  skills: [],
  text,
  deliverAs: 'turn' as const,
})

describe('会话接线的四条回归', () => {
  /*
   * 真实故障的正面判据：入口那一格（键是 `''`）的第一句话，必须能经 `prepare` 铸出号、
   * 落到新号上、并且不再抛「这个界面还没有接上助手会话。」。
   *
   * 顺序是这一条的全部内容：**先 prepare 再取端口**。反过来的话入口页永远发不出第一句。
   */
  test('入口页第一句话：先铸号再取端口，提交落到新号上', async () => {
    const ports = new Map<string, ReturnType<typeof fakePort>>()
    const store = new TranscriptStore({
      sessions: (id) => {
        const held = ports.get(id) ?? fakePort(id)
        ports.set(id, held)
        return held.port
      },
    })
    const entry = createThreadEntry()
    const request = {
      init: { workspaceId: 'w1' },
      create: async () => thread('t-new'),
      created: () => undefined,
      sessions: {
        port: (id: string) => {
          const held = ports.get(id) ?? fakePort(id)
          ports.set(id, held)
          return held.port
        },
        peek: (id: string) => ports.get(id)?.port,
        release: () => undefined,
        releaseAll: () => undefined,
        size: () => ports.size,
      },
    }

    const handle = await store.send({
      ...submit('你好'),
      threadId: '',
      prepare: () => entry.prepare(request),
    })

    expect(handle?.promptId).toBe('p1')
    /* 提交落在新号上：入口那一格迁过去，正文跟着一起。 */
    expect(ports.get('t-new')?.state.prompts).toEqual(['你好'])
    expect(store.read('t-new').loaded).toBe(false)
    expect(store.read('t-new').submissions.map((entry_) => entry_.text)).toEqual(['你好'])
    /*
     * 入口那一格**不记别名**：它是「还没铸号」这个位置，不是某条对话。
     * 记成 `'' -> t-new` 之后，下一次从入口页发消息时，提交会先写进上一条对话
     * （真机故障：上一条对话冒出幽灵提交、新对话的气泡要等 AI 回复完才出现）。
     */
    expect(store.read('').submissions).toEqual([])
  })

  test('createThread 失败：正文留在横幅里，端口一根都没建 —— 不留空线程', async () => {
    let factories = 0
    const store = new TranscriptStore({
      sessions: (id) => {
        factories += 1
        return fakePort(id).port
      },
    })

    const handle = await store.send({
      ...submit('这句话要取回来'),
      threadId: '',
      prepare: () => Promise.reject(new Error('network down')),
    })

    expect(handle).toBeNull()
    /* 正文还在（横幅上的「取回文字」认的就是它），来源标成 failed。 */
    const held = store.read('')
    expect(held.submissions.map((entry) => [entry.text, entry.phase])).toEqual([['这句话要取回来', 'failed']])
    expect(held.operation.kind).toBe('failed')
    /* 端口一根都没建：失败发生在铸号那一步，没有号就没有会话。 */
    expect(factories).toBe(0)
  })

  test('连续两次发送：只铸出一条线程（进行中的那一趟被复用）', async () => {
    let created = 0
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ports = createSessionRegistry({
      api: {} as never,
    })
    const entry = createThreadEntry()
    const request = {
      init: { workspaceId: 'w1' },
      create: async () => {
        created += 1
        await gate
        return thread('t1')
      },
      created: () => undefined,
      sessions: ports,
    }

    const first = entry.prepare(request)
    const second = entry.prepare(request)
    release()

    const [left, right] = await Promise.all([first, second])
    expect(created).toBe(1)
    expect(left?.key).toBe('t1')
    expect(right?.key).toBe('t1')
    /* 第三次是顺序调用：已经铸过，原样交回，不再建第二条。 */
    expect((await entry.prepare(request))?.key).toBe('t1')
    expect(created).toBe(1)
  })

  test('StrictMode 渲染两遍：同一条对话的订阅不翻倍', async () => {
    const ports = new Map<string, ReturnType<typeof fakePort>>()
    const store = new TranscriptStore({
      sessions: (id) => {
        const held = ports.get(id) ?? fakePort(id)
        ports.set(id, held)
        return held.port
      },
    })

    /* 注册表保证同一号永远交回同一根端口 —— 组件重渲染、双渲染都只走这一条。 */
    store.ensure('t1')
    store.ensure('t1')
    store.ensure('t1')

    expect(ports.get('t1')?.state.active).toBe(4)
  })

  test('forget 之后：订阅全部退掉，一根不留（StrictMode 也不泄漏）', () => {
    const ports = new Map<string, ReturnType<typeof fakePort>>()
    const store = new TranscriptStore({
      sessions: (id) => {
        const held = ports.get(id) ?? fakePort(id)
        ports.set(id, held)
        return held.port
      },
    })

    store.ensure('t1')
    store.ensure('t2')
    expect(ports.get('t1')?.state.active).toBe(4)
    expect(ports.get('t2')?.state.active).toBe(4)

    store.forget('t1')
    expect(ports.get('t1')?.state.active).toBe(0)
    expect(ports.get('t2')?.state.active).toBe(4)

    store.dispose()
    expect(ports.get('t2')?.state.active).toBe(0)
  })
})

/*
 * 真实故障：对话已经结束，发送键却一直转圈。
 *
 * 根因是**两本账记的号不是同一套**。`TranscriptStore.#publish` 按 agent 报的
 * `promptId`（快照里 prompt 自己的号，`knownPromptIds` 扫的就是它）销掉待发提交；
 * 而这一侧存进 `PendingSubmission.promptId` 的，是 UI 自己铸的 **clientTurnId**
 * （`session-port.ts` 的 `prompt` 把它当 promptId 交回）。两个词表交集为空 —— 那一条
 * 提交永远收不掉，`activityOf` 恒判「提交中」，`PromptInputSubmit` 的 svg 就一直在转。
 *
 * 修法是给 store 补一口**按 clientTurnId 销账**的入口（`settleSubmissions`），由
 * `ui/index.tsx` 从 `turn.upsert` 带回的 `clientTurnId` 调用 —— 真实那一轮出现了，
 * 这一句就不再是「待发」。
 */
describe('待发提交按 clientTurnId 收口（发送键不再空转）', () => {
  /** 造一台只认「提交」的假端口；promptId 就是调用方给的号，便于对照。 */
  function storeWithPort() {
    const ports = new Map<string, ReturnType<typeof fakePort>>()
    const store = new TranscriptStore({
      sessions: (id) => {
        const held = ports.get(id) ?? fakePort(id)
        ports.set(id, held)
        return held.port
      },
    })
    return { ports, store }
  }

  test('settleSubmissions 按存下的号收掉那一条（并把提交表清空）', async () => {
    const { store } = storeWithPort()
    const handle = await store.send({ ...submit('你好'), threadId: 't1' })

    expect(handle).not.toBeNull()
    /* 提交表里存的是 port 交回的那个号（真机上是 clientTurnId）。 */
    expect(store.read('t1').submissions.map((entry) => entry.promptId)).toEqual([handle!.promptId])
    expect(store.read('t1').status).toBe('submitted')

    store.settleSubmissions('t1', [handle!.promptId])

    expect(store.read('t1').submissions).toEqual([])
    /* 收掉之后没有待发提交，也没在跑 —— 状态不再是「提交中」（发送键不转的前提）。 */
    expect(store.read('t1').status).not.toBe('submitted')
  })

  test('settleSubmissions 只动点名的号：别的、别的线程都不受影响', async () => {
    const { store } = storeWithPort()
    const first = await store.send({ ...submit('A'), threadId: 't1' })
    const second = await store.send({ ...submit('B'), threadId: 't1' })
    const other = await store.send({ ...submit('C'), threadId: 't2' })

    store.settleSubmissions('t1', [first!.promptId])

    expect(store.read('t1').submissions.map((entry) => entry.promptId)).toEqual([second!.promptId])
    expect(store.read('t2').submissions.map((entry) => entry.promptId)).toEqual([other!.promptId])
  })

  test('settleSubmissions 空数组是空操作', async () => {
    const { store } = storeWithPort()
    await store.send({ ...submit('你好'), threadId: 't1' })

    store.settleSubmissions('t1', [])

    expect(store.read('t1').submissions.length).toBe(1)
  })

  test('已经失败的提交不被收掉（「取回文字」那颗键要留着）', async () => {
    const { store } = storeWithPort()
    const handle = await store.send({
      ...submit('这句要取回来'),
      threadId: 't1',
      prepare: () => Promise.reject(new Error('network down')),
    })

    expect(handle).toBeNull()
    expect(store.read('t1').submissions.map((entry) => entry.phase)).toEqual(['failed'])

    /* 没有号可点，但即使点了同一个位置也不该把它收走 —— failed 是给人看的。 */
    store.settleSubmissions('t1', ['whatever'])
    expect(store.read('t1').submissions.map((entry) => entry.phase)).toEqual(['failed'])
  })

  test('settleSubmissions 落到没有记录的键上是空操作', () => {
    const store = new TranscriptStore({ sessions: () => fakePort('t1').port })

    store.settleSubmissions('t-absent', ['p1'])

    expect(store.read('t-absent').submissions).toEqual([])
  })
})

/*
 * R-04 §3.6：Core 换代之后，已绑定的对话要能重读；正在显示的立即读，其余等下次打开。
 *
 * 旧实现没有这两口：重启之后 UI 侧没有任何路径知道「副本的游标属于旧进程」，
 * 时间线于是冻结（新进程的 seq 从 1 重新开始，副本按旧水位判成重复）。
 */
describe('Core 换代后的重新同步（R-04 §3.6）', () => {
  /** 一根可记账、可主动推信号的假端口。 */
  function recordingPort(threadId: string) {
    let listener: ((signal: import('../../agent/transcript').TranscriptSignal) => void) | null = null
    const state = { reads: 0, queues: 0, nextSeq: 100 }
    const page = (): TranscriptPage => ({ ...EMPTY_PAGE, seq: state.nextSeq })
    const port: AgentSessionPort = {
      transcript: {
        subscribeTranscript: (l) => {
          listener = l
          return () => {
            listener = null
          }
        },
        readTranscript: async () => {
          state.reads += 1
          return page()
        },
        catchUpTranscript: async (_sessionId, agentId, sinceSeq) => ({
          agentId,
          batches: [],
          latestSeq: sinceSeq,
          complete: true,
        }),
      },
      prompt: async () => ({ sessionId: threadId, promptId: 'p1' }),
      cancel: async () => undefined,
      readQueue: async () => {
        state.queues += 1
        return { ...EMPTY_QUEUE, threadId }
      },
      withdraw: async () => null,
      move: async () => ({ ...EMPTY_QUEUE, threadId }),
      setDeliveryModes: async () => ({ ...EMPTY_QUEUE, threadId }),
      subscribeQueue: () => () => undefined,
      subscribePromptDropped: () => () => undefined,
      subscribeRunFailed: () => () => undefined,
      abortPrompt: async () => undefined,
      resolvePermission: async () => undefined,
      resolvePlan: async () => undefined,
      answerQuestions: async () => undefined,
      dismissQuestions: async () => undefined,
    }
    return {
      port,
      state,
      emit: (signal: import('../../agent/transcript').TranscriptSignal) => listener?.(signal),
    }
  }

  test('R-04 S4 reset 之后同号 seq=1 的 ops 被应用（快照里看得到）', async () => {
    const held = recordingPort('t1')
    const store = new TranscriptStore({ sessions: () => held.port })
    store.open('t1')
    await Bun.sleep(0)
    expect(held.state.reads).toBe(1)

    /*
     * 模拟端口层的换代输出：一条 reset，随后新进程 seq=1 的 op。
     *
     * 换代后的整读交回**新进程的水位 0**（旧进程留在副本里的水位是 100）——
     * 这正是旧代码丢掉整批新数据的那种相位。
     */
    held.state.nextSeq = 0
    held.emit({ kind: 'reset', sessionId: 't1', agentId: 'main', seq: undefined })
    await Bun.sleep(0)
    expect(held.state.reads).toBe(2)

    held.emit({
      kind: 'ops',
      sessionId: 't1',
      agentId: 'main',
      seq: 1,
      ops: [
        {
          op: 'turn.upsert',
          turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'other' } },
        } as never,
      ],
    })
    await Bun.sleep(0)
    /* seq=1 被真的应用：这一轮画进了时间线（状态跟着 running）。 */
    expect(store.read('t1').loaded).toBe(true)
    expect(store.read('t1').status).toBe('running')
  })

  test('R-04 S5 markAllStale → resyncVisible 只重读有监听者的那条', async () => {
    const a = recordingPort('A')
    const b = recordingPort('B')
    const store = new TranscriptStore({ sessions: (id) => (id === 'A' ? a.port : b.port) })
    store.open('A')
    store.open('B')
    await Bun.sleep(0)
    expect([a.state.reads, b.state.reads]).toEqual([1, 1])

    /* A 在屏幕上（有订阅者），B 没人在看。 */
    store.subscribe('A', () => undefined)
    store.markAllStale()
    expect(store.resyncVisible()).toEqual(['A'])
    await Bun.sleep(0)
    expect([a.state.reads, b.state.reads]).toEqual([2, 1])

    /* 之后真的打开 B：它按「换代后的第一次」重读一次。 */
    store.open('B')
    await Bun.sleep(0)
    expect(b.state.reads).toBe(2)
  })

  test('R-04 S6 forget 之后 resyncVisible 不报错、也不再处理那条', async () => {
    const a = recordingPort('A')
    const store = new TranscriptStore({ sessions: () => a.port })
    store.open('A')
    await Bun.sleep(0)
    store.subscribe('A', () => undefined)
    store.markAllStale()
    store.forget('A')

    expect(store.resyncVisible()).toEqual([])
    expect(a.state.reads).toBe(1)
  })
})
