import { describe, expect, test } from 'bun:test'
import type { Thread } from '../../../../contract'
import { createSessionRegistry, createThreadEntry } from '../../../session'
import type {
  AgentPromptHandle,
  AgentPromptRequest,
  AgentSessionPort,
  QueuedMessages,
} from '../../../shared/model/session'
import type { TranscriptPage } from '../../../shared/model/transcript'
import { selectPresentation } from '../../presentation'
import { TranscriptStore } from '../transcript-store'
import { readFailedSubmissionText } from '../use-assistant-session'

/*
 * 真实故障「这个界面还没有接上助手会话。」的守卫：四条都盯着**端口这一层的身份与生命周期**。
 * 它们是纯 store/状态机，不需要渲染树 —— 判据写在这里，组件只负责把它们接起来。
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

/** `active` 是此刻还活着的订阅数（订阅加一、退订减一）—— 第 3、4 条判据量它。 */
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
    answerDialog: async () => undefined,
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
  /* 顺序是这一条的全部内容：**先 prepare 再取端口**，反过来的话入口页永远发不出第一句。 */
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
     * 入口那一格**不记别名**：记成 `'' -> t-new` 后，下次从入口页发消息会先写进上一条对话
     * （真机故障：上一条冒出幽灵提交、新对话的气泡要等 AI 回复完才出现）。
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
    /* 正文还在（横幅上的「取回文字」认的就是它）。 */
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
    /* 第三次已经铸过，原样交回，不再建第二条。 */
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
 * 真实故障：对话已经结束，发送键却一直转圈。根因是**两本账记的号不是同一套** —— `#publish` 按 agent 报的 `promptId` 销账，
 * 而这一侧存的是 UI 铸的 **clientTurnId**，两个词表交集为空，那一条提交永远收不掉，`activityOf` 恒判「提交中」。
 * 修法是补一口按 clientTurnId 销账的入口（`settleSubmissions`），由 `ui/index.tsx` 从 `turn.upsert` 的 `clientTurnId` 调用。
 */
describe('待发提交按 clientTurnId 收口（发送键不再空转）', () => {
  /** 造一台只认「提交」的假端口；promptId 就是调用方给的号。 */
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
    /* 收掉后没有待发提交也没在跑 —— 状态不再是「提交中」，这是发送键不转的前提。 */
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

  /*
   * R-20-1：忙时发的一句被 Core 降级成排队，送达时**没有任何 turn 带这个号**，`settleSubmissions` 等不到它。
   * Core 收口时推的 `submissions.removed` 就是它的终点。
   */
  test('removeSubmission 同时收掉本机按同号铸的那条提交（即使 Core 行这一侧没有它）', async () => {
    const { store } = storeWithPort()
    const handle = await store.send({ ...submit('排进去的一句'), threadId: 't1' })
    const other = await store.send({ ...submit('另一句'), threadId: 't1' })

    store.removeSubmission('t1', handle!.promptId)

    expect(store.read('t1').submissions.map((entry) => entry.promptId)).toEqual([other!.promptId])
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
 * Core 换代之后：正在显示的对话立即重读，其余等下次打开。旧实现没有这两口 —— 重启后 UI 侧没有任何路径知道
 * 「副本的游标属于旧进程」，时间线于是冻结（新进程 seq 从 1 重来，副本按旧水位判成重复）。
 */
describe('Core 换代后的重新同步（R-04 §3.6）', () => {
  /** 一根可记账、可主动推信号的假端口。 */
  function recordingPort(threadId: string) {
    let listener: ((signal: import('../../../shared/model/transcript').TranscriptSignal) => void) | null = null
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
      answerDialog: async () => undefined,
      dismissQuestions: async () => undefined,
    }
    return {
      port,
      state,
      emit: (signal: import('../../../shared/model/transcript').TranscriptSignal) => listener?.(signal),
    }
  }

  test('R-04 S4 reset 之后同号 seq=1 的 ops 被应用（快照里看得到）', async () => {
    const held = recordingPort('t1')
    const store = new TranscriptStore({ sessions: () => held.port })
    store.open('t1')
    await Bun.sleep(0)
    expect(held.state.reads).toBe(1)

    /* 换代后的整读交回**新进程的水位 0**（旧进程留在副本里的是 100）—— 这正是旧代码丢掉整批新数据的相位。 */
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
    /* seq=1 被真的应用：这一轮画进了时间线。 */
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

/*
 * 排过队 / 插过话的那一句，Core 重启后是「未送达」：omp 的插话 / 排队队列住进程内存，Core 一崩就没了。
 * 界面从前只画 `deliverAs === 'turn'` 的提交行，于是那句话在屏幕上一个字都不剩 —— 没有队列、没有气泡、也没有真实轮。
 */
describe('R-08-5 未送达的插话 / 排队也画成气泡', () => {
  const submission = (over: Partial<import('../../../../contract').SubmissionView>) => ({
    clientTurnId: 'c1',
    threadId: 't1',
    text: '排了一句',
    attachments: [],
    skills: [],
    deliverAs: 'followUp' as const,
    status: 'failed' as const,
    turnId: null,
    error: { code: 'conversation.core_restarted', message: 'Core 已重启' },
    rev: 2,
    createdAt: 10,
    ...over,
  })

  function rowsOf(store: TranscriptStore, key: string) {
    return store
      .read(key)
      .timeline.active.items.filter((item) => item.type === 'user_message')
      .map((item) => item as { id: string; text: string; undelivered?: boolean })
  }

  test('failed 的 followUp 画进时间线，并标成未送达', () => {
    const store = new TranscriptStore({ sessions: () => fakePort('t1').port })
    store.open('t1')

    store.upsertSubmission('t1', submission({}))

    expect(rowsOf(store, 't1').map((row) => [row.text, row.undelivered])).toEqual([['排了一句', true]])
  })

  test('failed 的 steer 同样画出来；queued 与 pending 的插话 / 排队照旧不画', () => {
    const store = new TranscriptStore({ sessions: () => fakePort('t1').port })
    store.open('t1')
    store.upsertSubmission('t1', submission({ clientTurnId: 'c1', deliverAs: 'steer', text: '插了一句' }))
    store.upsertSubmission(
      't1',
      submission({ clientTurnId: 'c2', deliverAs: 'followUp', status: 'queued', text: '还在排队' }),
    )
    store.upsertSubmission(
      't1',
      submission({ clientTurnId: 'c3', deliverAs: 'steer', status: 'pending', text: '还没交出去' }),
    )

    /* 排队中的那些由队列区显示，时间线里不该多一份。 */
    expect(rowsOf(store, 't1').map((row) => row.text)).toEqual(['插了一句'])
  })

  test('正常走过的 turn 行不带未送达标记', () => {
    const store = new TranscriptStore({ sessions: () => fakePort('t1').port })
    store.open('t1')

    store.upsertSubmission('t1', submission({ status: 'pending', deliverAs: 'turn', text: '正常的一句' }))

    expect(rowsOf(store, 't1').map((row) => [row.text, row.undelivered])).toEqual([['正常的一句', undefined]])
  })

  /* 提交行就是真实 turn 到之前的那只气泡：文件记号与图要和换上来的真实投影同形，发出去那一刻不能先没了再冒出来 */
  test('提交行带上附件：文件成记号、图片用预览地址', () => {
    const store = new TranscriptStore({ sessions: () => fakePort('t1').port })
    store.open('t1')

    store.upsertSubmission(
      't1',
      submission({
        status: 'pending',
        deliverAs: 'turn',
        text: '你可以看见吗',
        attachments: [
          { id: 'a1', name: 'div.md', mime: 'text/markdown', kind: 'file', size: 2048, previewUrl: null },
          { id: 'a2', name: 'p.png', mime: 'image/png', kind: 'image', size: 9, previewUrl: 'poietica-asset://x' },
        ],
      }),
    )

    const [row] = store
      .read('t1')
      .timeline.active.items.filter((item) => item.type === 'user_message')
      .map((item) => item as { files?: { name: string }[]; images?: { url?: string }[] })
    expect(row?.files?.map((file) => file.name)).toEqual(['div.md'])
    expect(row?.images).toEqual([{ url: 'poietica-asset://x' }])
  })

  /* R-20-1：数组顺序是到达顺序，不是提交顺序 —— retry 的回执、迟到的快照都会把旧行排到末尾 */
  test('失败行按 createdAt 取最晚的一条，不按到达顺序', () => {
    const store = new TranscriptStore({ sessions: () => fakePort('t1').port })
    store.open('t1')

    store.upsertSubmission(
      't1',
      submission({ clientTurnId: 'c2', text: '新的一句', status: 'started', turnId: 't1', createdAt: 20 }),
    )
    store.upsertSubmission('t1', submission({ clientTurnId: 'c1', text: '旧的一句', createdAt: 10 }))
    expect(readFailedSubmissionText(store.read('t1'))).toBeNull()

    store.upsertSubmission('t1', submission({ clientTurnId: 'c3', text: '最新的失败', createdAt: 30 }))
    expect(readFailedSubmissionText(store.read('t1'))).toBe('最新的失败')
  })

  /*
   * Core 库里的失败行是排队 / 插话那一路唯一的来源 —— 本机从不登记它们。只认**最后一条**，
   * 否则人重发之后旧失败还会顶在横幅上。
   */
  test('失败行的正文按最后一条取；成功的那些不算', () => {
    const store = new TranscriptStore({ sessions: () => fakePort('t1').port })
    store.open('t1')

    store.upsertSubmission('t1', submission({ clientTurnId: 'c1', text: '旧的一句' }))
    expect(readFailedSubmissionText(store.read('t1'))).toBe('旧的一句')

    /* 之后又成功发出了一句：失败这件事已经翻篇，横幅与那颗键都不该再出现。 */
    store.upsertSubmission('t1', submission({ clientTurnId: 'c2', text: '新的一句', status: 'started', turnId: 't1' }))
    expect(readFailedSubmissionText(store.read('t1'))).toBeNull()
  })
})

/*
 * Core 在一轮中途没了（崩溃、被关掉）：那一轮**再也不会**有帧了，本机必须把它收掉。
 *
 * 收掉的动作原先只动 `run.settled`，**不写终局** —— 于是封条落到「缺终局就按正常答完算」那一支，
 * 屏幕上报的是「已完成」、过程还能折。可这一轮根本没答完：它死在半路。
 * DSH 对同一种情形（turn/end 的 reason 是 `interrupted`，即进程先退出了）报的是「已停止」——
 * 死掉的一轮不能报成答完的一轮。
 */
describe('进程中途没了那一轮报「已停止」，不报「已完成」', () => {
  /** 能捕获 `RunFailed` 订阅者的假端口（真接线在装配层，这里直接把它拉出来问）。 */
  function dyingPort(threadId: string) {
    let listener: ((signal: import('../../../shared/model/transcript').TranscriptSignal) => void) | null = null
    let runFailed: ((failed: import('../../../shared/model/session').RunFailed) => void) | null = null
    const port: AgentSessionPort = {
      transcript: {
        subscribeTranscript: (l) => {
          listener = l
          return () => {
            listener = null
          }
        },
        readTranscript: async () => EMPTY_PAGE,
        catchUpTranscript: async (_sessionId, agentId, sinceSeq) => ({
          agentId,
          batches: [],
          latestSeq: sinceSeq,
          complete: true,
        }),
      },
      prompt: async (): Promise<AgentPromptHandle> => ({ sessionId: threadId, promptId: 'p1' }),
      cancel: async () => undefined,
      readQueue: async () => ({ ...EMPTY_QUEUE, threadId }),
      withdraw: async () => null,
      move: async () => ({ ...EMPTY_QUEUE, threadId }),
      setDeliveryModes: async () => ({ ...EMPTY_QUEUE, threadId }),
      subscribeQueue: () => () => undefined,
      subscribePromptDropped: () => () => undefined,
      subscribeRunFailed: (l) => {
        runFailed = l
        return () => {
          runFailed = null
        }
      },
      abortPrompt: async () => undefined,
      resolvePermission: async () => undefined,
      resolvePlan: async () => undefined,
      answerQuestions: async () => undefined,
      answerDialog: async () => undefined,
      dismissQuestions: async () => undefined,
    }
    return {
      port,
      emit: (signal: import('../../../shared/model/transcript').TranscriptSignal): void => listener?.(signal),
      /* 让这一轮真的跑起来：一轮 + 一个段 + 一次 read（有过程可折，才谈得上折不折）。 */
      openTurn: (): void => {
        /* seq 必须接在初始整读的水位之后（EMPTY_PAGE.seq = 1），否则会被当成重复批丢掉。 */
        listener?.({
          kind: 'ops',
          sessionId: threadId,
          agentId: 'main',
          seq: 2,
          ops: [
            {
              op: 'turn.upsert',
              turn: {
                kind: 'turn',
                turnId: 't1',
                ordinal: 1,
                state: 'running',
                origin: { kind: 'user' },
                prompt: '干活',
                startedAt: '2026-10-10T00:00:00.000Z',
              },
            },
            {
              op: 'step.upsert',
              turnId: 't1',
              step: {
                kind: 'step',
                stepId: 't1:s0',
                turnId: 't1',
                ordinal: 0,
                state: 'running',
                startedAt: '2026-10-10T00:00:00.000Z',
              },
            },
            {
              op: 'frame.upsert',
              turnId: 't1',
              stepId: 't1:s0',
              frame: {
                kind: 'tool',
                frameId: 't1:s0:t0',
                name: 'read',
                toolCallId: 'c1',
                input: {},
                output: '',
                state: 'done',
              },
            },
          ],
        } as never)
      },
      fail: (message: string, degraded = false): void => {
        runFailed?.({ threadId, message, degraded })
      },
    }
  }

  test('本机把这一轮收掉时写下终局：aborted（封条因此报「已停止」）', async () => {
    const held = dyingPort('t1')
    const store = new TranscriptStore({ sessions: () => held.port })
    store.open('t1')
    await Bun.sleep(0)

    held.openTurn()
    await Bun.sleep(0)
    expect(store.read('t1').timeline.active.outcome).toBeUndefined()

    held.fail('Core 断了')
    await Bun.sleep(0)

    const timeline = store.read('t1').timeline
    expect(timeline.status).toBe('failed')
    expect(timeline.active.run?.settled).toBe(true)
    /* 这就是这条用例的全部意义：终局必须是「被人叫停」，不是「答完了」。 */
    expect(timeline.active.outcome).toBe('aborted')
  })

  test('收掉之后封条摊开且不可折：死在哪得让人看得见', async () => {
    const held = dyingPort('t1')
    const store = new TranscriptStore({ sessions: () => held.port })
    store.open('t1')
    await Bun.sleep(0)

    held.openTurn()
    await Bun.sleep(0)
    held.fail('Core 断了')
    await Bun.sleep(0)

    const feed = selectPresentation(store.read('t1').timeline, new Map())
    let seal: { canCollapse: boolean; isOpen: boolean } | undefined
    for (let index = 0; index < feed.count; index += 1) {
      const found = feed.sealAt(index)
      if (found !== undefined) {
        seal = found
        break
      }
    }

    expect(seal?.canCollapse).toBe(false)
    expect(seal?.isOpen).toBe(true)
  })

  test('跑完了只是掉了帧（degraded）：照旧「已完成」，不改口成「已停止」', async () => {
    const held = dyingPort('t1')
    const store = new TranscriptStore({ sessions: () => held.port })
    store.open('t1')
    await Bun.sleep(0)

    held.openTurn()
    await Bun.sleep(0)
    held.fail('内部诊断：丢了 3 帧', true)
    await Bun.sleep(0)

    const timeline = store.read('t1').timeline
    expect(timeline.active.run?.settled).toBe(true)
    /* 这一轮是真答完了（`degraded` 的 message 只是一句内部诊断）—— 不能报成「已停止」。 */
    expect(timeline.active.outcome).toBeUndefined()
  })

  test('在跑的那一轮（还没有终局）被收掉：补的就是 aborted', async () => {
    const held = dyingPort('t1')
    const store = new TranscriptStore({ sessions: () => held.port })
    store.open('t1')
    await Bun.sleep(0)

    held.openTurn()
    await Bun.sleep(0)
    /* 快照里这一轮是 `running`：`run` 在、`outcome` 不在 —— 这正是「死在半路」的形状。 */
    expect(store.read('t1').timeline.active.run).toBeDefined()
    expect(store.read('t1').timeline.active.outcome).toBeUndefined()

    held.fail('Core 断了')
    await Bun.sleep(0)

    expect(store.read('t1').timeline.active.outcome).toBe('aborted')
  })

  test('agent 自己报过终局时不改口：本机只补缺的那一格', async () => {
    const held = dyingPort('t1')
    const store = new TranscriptStore({ sessions: () => held.port })
    store.open('t1')
    await Bun.sleep(0)

    held.openTurn()
    await Bun.sleep(0)
    /* agent 已经报过「答完了」，之后本机才把这一轮收掉。 */
    held.emit({
      kind: 'ops',
      sessionId: 't1',
      agentId: 'main',
      seq: 3,
      ops: [
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            origin: { kind: 'user' },
            prompt: '干活',
            startedAt: '2026-10-10T00:00:00.000Z',
            endedAt: '2026-10-10T00:00:05.000Z',
          },
        },
      ],
    } as never)
    await Bun.sleep(0)
    expect(store.read('t1').timeline.active.outcome).toBe('completed')

    held.fail('Core 断了')
    await Bun.sleep(0)

    expect(store.read('t1').timeline.active.outcome).toBe('completed')
  })

  test('写下的终局活得过下一次投影（快照每次整块重算）', async () => {
    const held = dyingPort('t1')
    const store = new TranscriptStore({ sessions: () => held.port })
    store.open('t1')
    await Bun.sleep(0)

    held.openTurn()
    await Bun.sleep(0)
    held.fail('Core 断了')
    await Bun.sleep(0)

    /* 再推一条无关的快照：投影会把 timeline 整块重算，本机写的那一格不能被冲掉。 */
    held.emit({
      kind: 'ops',
      sessionId: 't1',
      agentId: 'main',
      seq: 3,
      ops: [],
    } as never)
    await Bun.sleep(0)

    expect(store.read('t1').timeline.active.outcome).toBe('aborted')
  })
})

describe('入口页开的对话：队列的撤回 / 换层落到真对话的端口上', () => {
  /*
   * 真实故障：从入口页发第一句开出的对话，AI 回复时再发一句进了队列，队列条上「插话」「撤回」两枚键点了都没反应。
   * 队列条在入口页就挂上了，`queue('')` 那一刻把键 `''` 关进了闭包；第一句话把它迁到真对话号下 —— 快照照收、屏幕照画，
   * 但写动作仍拿 `''` 找端口，而入口那一格没有端口（也不记别名），于是失败记在 `''` 上，对话里什么都看不见。
   */
  function entryStore(writes: Pick<AgentSessionPort, 'withdraw' | 'move'>) {
    const ports = new Map<string, AgentSessionPort>()
    const portOf = (id: string): AgentSessionPort => {
      const held = ports.get(id) ?? { ...fakePort(id).port, ...writes }
      ports.set(id, held)
      return held
    }
    const store = new TranscriptStore({ sessions: portOf })
    const entry = createThreadEntry()
    const request = {
      init: { workspaceId: 'w1' },
      create: async () => thread('t-new'),
      created: () => undefined,
      sessions: {
        port: portOf,
        peek: (id: string) => ports.get(id),
        release: () => undefined,
        releaseAll: () => undefined,
        size: () => ports.size,
      },
    }
    return { store, prepare: () => entry.prepare(request) }
  }

  test('Q1 入口页挂上的队列迁到新对话后，撤回与换层都走新对话的端口', async () => {
    const calls: string[] = []
    const { store, prepare } = entryStore({
      withdraw: async (itemId) => {
        calls.push(`withdraw ${itemId}`)
        return { text: '排队的一句' }
      },
      move: async (itemId, deliverAs) => {
        calls.push(`move ${itemId} ${deliverAs}`)
        return { ...EMPTY_QUEUE, threadId: 't-new' }
      },
    })
    /* 入口页渲染时就取了这一格的队列（输入框只挂一处，队列条跟着它）。 */
    const early = store.queue('')
    await store.send({ ...submit('你好'), threadId: '', prepare })
    expect(store.queue('t-new')).toBe(early)

    expect(await early.withdraw('q1')).toEqual({ text: '排队的一句' })
    await early.move('q2', 'followUp')
    expect(calls).toEqual(['withdraw q1', 'move q2 followUp'])
    expect(store.read('t-new').operation.kind).not.toBe('failed')
    expect(store.read('').operation.kind).not.toBe('failed')
  })

  test('Q2 迁走之后入口那一格重新取到的是一份新队列，写动作不串到上一条对话', async () => {
    const { store, prepare } = entryStore({
      withdraw: async () => ({ text: '不该走到这里' }),
      move: async () => ({ ...EMPTY_QUEUE, threadId: 't-new' }),
    })
    const early = store.queue('')
    await store.send({ ...submit('你好'), threadId: '', prepare })
    const fresh = store.queue('')
    expect(fresh).not.toBe(early)
    /* 入口那一格还没有号：撤回拿不到端口，失败记在入口那一格，不碰 t-new。 */
    expect(await fresh.withdraw('q1')).toBeNull()
    expect(store.read('t-new').operation.kind).not.toBe('failed')
  })

  test('Q3 写动作失败时，横幅落在迁过去的那条对话上（不是看不见的入口那一格）', async () => {
    const { store, prepare } = entryStore({
      withdraw: async () => {
        throw new Error('这条消息已经交给 agent，撤不回来了')
      },
      move: async () => ({ ...EMPTY_QUEUE, threadId: 't-new' }),
    })
    const early = store.queue('')
    await store.send({ ...submit('你好'), threadId: '', prepare })
    expect(await early.withdraw('q1')).toBeNull()
    expect(store.read('t-new').operation.kind).toBe('failed')
    expect(store.read('').operation.kind).not.toBe('failed')
  })
})
