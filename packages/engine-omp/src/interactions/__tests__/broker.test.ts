import '../../__tests__/omp-home'
// 本文件经 ui-context 触到 omp 的运行时模块（pi-tui/theme 与 extensions/types 的函数），
// 所以按包内约定先钉住 omp 的隔离目录（12 页 §2.2）。
import '../../__tests__/omp-home'
import { describe, expect, test } from 'bun:test'
import { EngineErrorCode, type InteractionAnswer } from '@poietica/engine'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { applyOperation, EMPTY_AGENT_STATE } from '@poietica/transcript'
import type { InteractionDraft } from '../broker'
import { InteractionBroker, type InteractionChange } from '../broker'
import { createUiContext } from '../ui-context'

/*
 * 待答交互的生命周期：每一种开门都必须有一条关门的路。
 *
 * 迁移自 legacy 的 dialog-lifecycle.test.ts、dialog-abort.test.ts、cancel-drains-dialogs.test.ts：
 * 断言意图一条不删，只把 DialogDesk 换成 InteractionBroker（12 页 §12.3 的去向表）。
 * 起因是一个真实的挂死隐患：一道对话框若没人收尾，agent 那头永远停在 await 上，
 * 屏幕上是收不掉的带子，而日志里一个字都没有。所以判据不是「画不画得出来」，而是「有没有人收尾」。
 */

/** 一张只记账的桌：把每次问话与答复记下来，好让测试按同样的号答复 */
function brokerWithRecorder(now = 1_000): {
  broker: InteractionBroker
  changes: InteractionChange[]
} {
  const changes: InteractionChange[] = []
  const broker = new InteractionBroker(() => now)
  broker.onChange((change) => changes.push(change))
  return { broker, changes }
}

function requested(changes: readonly InteractionChange[]): InteractionChange[] {
  return changes.filter((change) => change.type === 'requested')
}

function resolved(changes: readonly InteractionChange[]): InteractionChange[] {
  return changes.filter((change) => change.type === 'resolved')
}

// 不加 as const：InteractionDraft 的 options 是可变的 string[]（engine 的形状），as const 会把它变成 readonly 元组
const SELECT: InteractionDraft = { kind: 'select', title: '选一个', options: ['a', 'b'] }

describe('InteractionBroker 的生命周期', () => {
  test('没人答的交互一直挂着 —— 这正是每次开门都必须有人关门的原因', async () => {
    const { broker, changes } = brokerWithRecorder()

    // 不 await：这一条问出去之后没人答，它就该一直挂着
    const pending = broker.ask(SELECT)

    expect(broker.pendingCount()).toBe(1)
    expect(requested(changes)).toHaveLength(1)

    // 用一个已经落定的答复证明它此前确实没结（同一条 promise 只能结一次）
    broker.answer(requested(changes)[0]!.id, { kind: 'select', value: 'a' })

    expect(await pending).toEqual({ kind: 'select', value: 'a' })
    expect(broker.pendingCount()).toBe(0)
  })

  test('答复不到的号如实说没有，而不是假装答上了', () => {
    const { broker } = brokerWithRecorder()

    // 假答等于让人以为答复送到了，而 agent 那头永远等不到
    expect(() => broker.answer('nobody-is-waiting', { kind: 'dismiss' })).toThrow(AppError)
    try {
      broker.answer('nobody-is-waiting', { kind: 'dismiss' })
    } catch (error) {
      expect((error as AppError).code).toBe(EngineErrorCode.interactionExpired)
    }
  })

  test('答复类型与请求类型不匹配要报错，dismiss 除外', async () => {
    const { broker, changes } = brokerWithRecorder()
    const pending = broker.ask(SELECT)
    const id = requested(changes)[0]!.id

    expect(() => broker.answer(id, { kind: 'confirm', value: true })).toThrow(AppError)
    try {
      broker.answer(id, { kind: 'confirm', value: true })
    } catch (error) {
      expect((error as AppError).code).toBe(SystemErrorCode.invalidParams)
    }
    // 报错之后那一条还在等：错的答复不改账
    expect(broker.pendingCount()).toBe(1)

    // dismiss 与任何请求类型都相容（「没人答」不是一种答复类型）
    broker.answer(id, { kind: 'dismiss' })
    expect(await pending).toEqual({ kind: 'dismiss' })
  })

  test('createdAt / timeoutAt 由注入的 now 算出，绝不用真实时钟', () => {
    const { broker } = brokerWithRecorder(4_200)
    void broker.ask(SELECT, { timeoutMs: 250 })
    void broker.ask({ kind: 'confirm', title: 'sure?', message: '继续吗' })

    const [first, second] = broker.pending()
    expect(first?.createdAt).toBe(4_200)
    expect(first?.timeoutAt).toBe(4_450)
    expect(second?.timeoutAt).toBeNull()
  })

  test('待答列表最老的在前', () => {
    const { broker } = brokerWithRecorder()
    void broker.ask({ kind: 'confirm', title: '先问的', message: '' })
    void broker.ask({ kind: 'confirm', title: '后问的', message: '' })

    expect(broker.pending().map((held) => (held.kind === 'confirm' ? held.title : ''))).toEqual(['先问的', '后问的'])
    // list() 是 04 页 §3.12 的旧名，与 pending() 是同一份账
    expect(broker.list()).toEqual(broker.pending())
  })

  test('超时收掉这次交互并告诉屏幕为什么', async () => {
    const { broker, changes } = brokerWithRecorder()
    const pending = broker.ask(SELECT, { timeoutMs: 5 })

    expect(await pending).toEqual({ kind: 'dismiss' })

    /*
     * 超时是**没人答**，不是一次答复：屏幕据 resolved 把那条带子收掉 —— 只结 Promise 而不告知，
     * 带子会永远停在那里，而它背后的对话框早就作废了。
     */
    expect(requested(changes)).toHaveLength(1)
    expect(resolved(changes)).toHaveLength(1)
    expect(resolved(changes)[0]?.answer).toEqual({ kind: 'dismiss' })
    expect(resolved(changes)[0]?.interaction.kind).toBe('select')
    expect(broker.pendingCount()).toBe(0)
  })

  test('resolved 带原交互与答复，投影器据此把卡片改成终态', async () => {
    const { broker, changes } = brokerWithRecorder()
    const pending = broker.ask({
      kind: 'approval',
      tool: 'bash',
      title: '允许使用工具：bash',
      detail: 'Command: ls',
      allowSessionScope: true,
    })
    const answer: InteractionAnswer = {
      kind: 'approval',
      decision: 'approve',
      scope: 'session',
      feedback: null,
    }
    broker.answer(requested(changes)[0]!.id, answer)
    await pending

    const done = resolved(changes)[0]!
    expect(done.resolved).toBe(true)
    expect(done.answer).toEqual(answer)
    expect(done.interaction.kind === 'approval' && done.interaction.tool).toBe('bash')
  })

  test('答复过的那一条再答复一次就是过期', async () => {
    const { broker, changes } = brokerWithRecorder()
    const pending = broker.ask(SELECT)
    const id = requested(changes)[0]!.id
    broker.answer(id, { kind: 'select', value: null })
    await pending

    expect(() => broker.answer(id, { kind: 'select', value: 'a' })).toThrow(AppError)
  })
})

describe('中止信号（迁移自 dialog-abort）', () => {
  test('后来中止的信号收掉这次交互', async () => {
    const { broker, changes } = brokerWithRecorder()
    const controller = new AbortController()
    const pending = broker.ask(SELECT, { signal: controller.signal })

    controller.abort()

    expect(await pending).toEqual({ kind: 'dismiss' })
    expect(resolved(changes)).toHaveLength(1)
    expect(broker.pendingCount()).toBe(0)
  })

  test('已经作废的信号也要收掉交互，而不是挂着它', async () => {
    const { broker, changes } = brokerWithRecorder()
    const controller = new AbortController()

    // 一个在登记之前就已经作废的信号：监听器不会有第二次机会响
    controller.abort()

    const pending = broker.ask(SELECT, { signal: controller.signal })

    expect(await pending).toEqual({ kind: 'dismiss' })
    expect(broker.pendingCount()).toBe(0)
    expect(resolved(changes)).toHaveLength(0)
  })

  test('已经作废的信号压根不把交互摆到人面前', async () => {
    const { broker, changes } = brokerWithRecorder()
    const controller = new AbortController()
    controller.abort()

    await broker.ask(SELECT, { signal: controller.signal })

    /*
     * 已经作废的那一次不该挂在人面前：没人能答它，屏幕上的带子只会永远收不掉。
     * 这一条钉的是「先看信号再登记」那个次序（12 页 §8.1 第 3 点）。
     */
    expect(changes).toEqual([])
    expect(broker.pending()).toEqual([])
  })
})

describe('取消一轮时的清场（迁移自 cancel-drains-dialogs）', () => {
  test('取消一轮收掉它正在等的那次审批', () => {
    // 取消之后那一条不再是 pending：带子的挂载条件因此不再成立
    const ops = [
      {
        op: 'interaction.upsert' as const,
        interaction: {
          interactionId: 'i1',
          interactionKind: 'approval' as const,
          toolCallId: 'bash',
          state: 'pending' as const,
        },
      },
      {
        op: 'interaction.upsert' as const,
        interaction: {
          interactionId: 'i1',
          interactionKind: 'approval' as const,
          toolCallId: 'bash',
          state: 'cancelled' as const,
        },
      },
    ]

    let state = EMPTY_AGENT_STATE
    for (const op of ops) state = applyOperation(state, op).state

    expect([...state.interactions.values()].map((held) => ({ id: held.interactionId, state: held.state }))).toEqual([
      { id: 'i1', state: 'cancelled' },
    ])
  })

  test('清场把 agent 卡着的每一条 promise 都兑现', async () => {
    const { broker } = brokerWithRecorder()

    // 三次问话都挂着（授权闸门那条路就是没有 signal 的那一种）
    const first = broker.ask({ kind: 'select', title: 'Allow tool: bash', options: ['Approve', 'Deny'] })
    const second = broker.ask({ kind: 'question', questions: [] })
    const third = broker.ask({ kind: 'confirm', title: 'sure?', message: '' })

    /*
     * 三个都要结：留着任何一个，上游那次工具调用就永远停在 await 上 ——
     * 这一轮已经取消了，没有人再会来答它。
     */
    expect(broker.cancelAll()).toBe(3)
    expect(await first).toEqual({ kind: 'dismiss' })
    expect(await second).toEqual({ kind: 'dismiss' })
    expect(await third).toEqual({ kind: 'dismiss' })
  })

  test('清场是幂等的，也不会打扰已经答过的那一条', async () => {
    const { broker, changes } = brokerWithRecorder()
    const settled = broker.ask(SELECT)
    broker.answer(requested(changes)[0]!.id, { kind: 'select', value: 'Approve' })

    expect(await settled).toEqual({ kind: 'select', value: 'Approve' })
    // 已经答过的那一个不该被再结一次，也不该被算进「还有几个在等」
    expect(broker.cancelAll()).toBe(0)
  })
})

describe('uiContext：omp 的对话框走 broker（12 页 §8.3）', () => {
  test('授权闸门的 select 变成审批交互，答复折回那颗按钮的字面量', async () => {
    const { broker } = brokerWithRecorder()
    const granted: string[] = []
    const ui = createUiContext(broker, { grantTool: (tool) => granted.push(tool) })

    const pending = ui.select('Allow tool: bash\nCommand: rm -rf build', ['Approve', 'Deny'])
    const asked = broker.pending()[0]

    expect(asked?.kind).toBe('approval')
    expect(asked?.kind === 'approval' && asked.title).toBe('允许使用工具：bash')
    expect(asked?.kind === 'approval' && asked.detail).toBe('Command: rm -rf build')

    broker.answer(asked!.id, { kind: 'approval', decision: 'approve', scope: 'session', feedback: null })

    expect(await pending).toBe('Approve')
    // 「本次会话都批准」是另一条设置，落点由 hook 交给会话（写 overlay，不落盘）
    expect(granted).toEqual(['bash'])
  })

  test('拒绝与没人答都折成 Deny（fail closed）', async () => {
    const { broker } = brokerWithRecorder()
    const granted: string[] = []
    const ui = createUiContext(broker, { grantTool: (tool) => granted.push(tool) })
    const title = 'Allow tool: read'

    const rejected = ui.select(title, ['Approve', 'Deny'])
    broker.answer(broker.pending()[0]!.id, { kind: 'approval', decision: 'reject', scope: 'once', feedback: null })
    expect(await rejected).toBe('Deny')

    const timedOut = ui.select(title, ['Approve', 'Deny'], { timeout: 5 })
    expect(await timedOut).toBe('Deny')
    expect(granted).toEqual([])
  })

  test('普通 select 交出选中的标签，没人答是 undefined', async () => {
    const { broker } = brokerWithRecorder()
    const ui = createUiContext(broker)

    const picked = ui.select('哪一条？', ['甲', { label: '乙', description: '说明' }])
    expect(broker.pending()[0]?.kind).toBe('select')
    broker.answer(broker.pending()[0]!.id, { kind: 'select', value: '乙' })
    expect(await picked).toBe('乙')

    const dismissed = ui.select('哪一条？', ['甲', '乙'])
    broker.answer(broker.pending()[0]!.id, { kind: 'dismiss' })
    expect(await dismissed).toBeUndefined()
  })

  test('confirm 的缺席只能是不确认', async () => {
    const { broker } = brokerWithRecorder()
    const ui = createUiContext(broker)

    const yes = ui.confirm('继续吗', '会改文件')
    broker.answer(broker.pending()[0]!.id, { kind: 'confirm', value: true })
    expect(await yes).toBe(true)

    const gone = ui.confirm('继续吗', '会改文件', { timeout: 5 })
    expect(await gone).toBe(false)
  })

  test('input 与 editor 是同一个交互的两支', async () => {
    const { broker } = brokerWithRecorder()
    const ui = createUiContext(broker)

    const one = ui.input('名字', '占位')
    expect(broker.pending()[0]).toMatchObject({ kind: 'input', placeholder: '占位', multiline: false })
    broker.answer(broker.pending()[0]!.id, { kind: 'input', value: '甲' })
    expect(await one).toBe('甲')

    const many = ui.editor('正文', '预填')
    expect(broker.pending()[0]).toMatchObject({ kind: 'input', placeholder: '预填', multiline: true })
    broker.answer(broker.pending()[0]!.id, { kind: 'dismiss' })
    expect(await many).toBeUndefined()
  })

  test('一道题都认不出的 askDialog 如实收成取消，而不是挂死', async () => {
    const { broker } = brokerWithRecorder()
    const ui = createUiContext(broker)

    /*
     * askDialog 的 Promise 若挂着，人没有可答的东西，模型会永远等下去。
     * omp 把 undefined 读成「用户取消」（tools/ask.ts:786-789），那一轮因此停在一个说得清的地方。
     */
    // askDialog 在接口上是可选成员：测试里断言它确实实现了，再调用
    const askDialog = ui.askDialog
    if (askDialog === undefined) throw new Error('ui-context 必须实现 askDialog')
    expect(await askDialog.call(ui, [])).toBeUndefined()
    expect(broker.pendingCount()).toBe(0)
  })

  test('交互式 TUI 的面逐个如实空实现', async () => {
    const { broker } = brokerWithRecorder()
    const ui = createUiContext(broker)

    expect(ui.getEditorText()).toBe('')
    expect(ui.getToolsExpanded()).toBe(false)
    expect(await ui.custom(() => ({ render: () => [] }) as never)).toBeUndefined()
    expect(await ui.getTheme('绝无此主题')).toBeUndefined()
    ui.notify('一条通知')
    ui.setStatus('k', undefined)
    ui.setWorkingMessage('工作中')
    ui.setTitle('标题')
    ui.setEditorText('文本')
    ui.pasteToEditor('文本')
    ui.setToolsExpanded(true)
    expect(typeof ui.onTerminalInput(() => undefined)).toBe('function')
    expect(ui.timeoutStartsOnPresentation).toBe(false)
  })
})
