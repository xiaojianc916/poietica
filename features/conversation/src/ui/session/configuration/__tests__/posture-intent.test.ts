import { describe, expect, test } from 'bun:test'
import { createPostureIntent, storedPostureOf } from '../posture-intent'

/*
 * 真实故障：批准方式**不持久**——在入口页选一次完全访问，切走页面或重启软件又回到默认档。
 * 记忆的正主是 uiState 的 `'conversation.permissionPosture'`；读盘与写回交给 preferences 的 uiState 槽（setup 阶段），
 * 这里只验内存那一格：`read()` 必须同步答得出来（两台 store 在 agent 答复落地那一刻要它判补发），变化要通知订阅者（槽据此写回）。
 */

describe('批准方式的持久意图', () => {
  test('没有意图时 read() 是 undefined（第一帧就是默认档）', () => {
    expect(createPostureIntent().read()).toBeUndefined()
  })

  test('restore() 把盘上那一份放进内存（重启后仍记得）', () => {
    const intent = createPostureIntent()

    intent.restore('auto')

    expect(intent.read()).toBe('auto')
  })

  test('盘上那份只认非空字符串：空串与别的类型按「没有意图」处置', () => {
    expect(storedPostureOf('auto')).toBe('auto')
    for (const stored of ['', 42, null, undefined, { posture: 'auto' }] as const) {
      expect(storedPostureOf(stored)).toBeNull()
    }
  })

  test('write() 同一趟立刻读得到，并通知订阅者（槽据此写回）', () => {
    const intent = createPostureIntent()
    let notified = 0
    intent.subscribe(() => {
      notified += 1
    })

    intent.write('auto')

    expect(intent.read()).toBe('auto')
    expect(notified).toBe(1)
  })

  test('write() 同一个值不重复通知（早退）', () => {
    const intent = createPostureIntent()
    let notified = 0
    intent.subscribe(() => {
      notified += 1
    })

    intent.write('yolo')
    intent.write('yolo')

    expect(notified).toBe(1)
  })

  test('write() 之后 restore() 不会把用户刚按下的那一档冲掉', () => {
    const intent = createPostureIntent()

    intent.write('auto')
    intent.restore('manual')

    expect(intent.read()).toBe('auto')
  })

  test('订阅者收到每一次真的变化（入口页那一格据此换初始值）', () => {
    const intent = createPostureIntent()
    const seen: (string | undefined)[] = []
    const stop = intent.subscribe(() => {
      seen.push(intent.read())
    })

    intent.restore('manual')
    intent.write('auto')
    stop()
    intent.write('yolo')

    expect(seen).toEqual(['manual', 'auto'])
  })
})
