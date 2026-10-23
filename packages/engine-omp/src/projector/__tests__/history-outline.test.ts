import { describe, expect, test } from 'bun:test'
import { type OmpMessage, projectHistoryPage } from '../history'
import { assistant, prompts, T0, user } from './fixtures/history'

/* n 轮对话：第 k 轮问「问 k」、答「答 k」。 */
function rounds(n: number): OmpMessage[] {
  const messages: OmpMessage[] = []
  for (let k = 1; k <= n; k += 1) {
    messages.push(user(`问 ${String(k)}`, k * 10), assistant(`答 ${String(k)}`, k * 10 + 5))
  }
  return messages
}

describe('轮次目录（minimap 的定义域）', () => {
  test('头页带整条对话的目录，较早的页不带', () => {
    const messages = rounds(30)
    const head = projectHistoryPage(messages, null)
    expect(head.items.length).toBe(20)
    expect(head.outline?.length).toBe(30)
    expect(head.outline?.[0]).toEqual({ turnId: 't1', ordinal: 1, prompt: '问 1', reply: '答 1' })
    expect(head.outline?.at(-1)?.turnId).toBe('t30')

    const older = projectHistoryPage(messages, 't11')
    expect(older.outline).toBeUndefined()
  })

  test('目标续跑轮不进目录，轮号与时间线一致', () => {
    const page = projectHistoryPage(
      [
        user('把测试迁完', 0),
        assistant('第一轮', 10),
        { role: 'custom', customType: 'goal-continuation', timestamp: T0 + 20, content: '继续', display: false },
        assistant('第二轮', 30),
        user('第三句', 40),
      ] as OmpMessage[],
      null,
    )
    expect(page.outline?.map((entry) => entry.turnId)).toEqual(['t1', 't3'])
    expect(page.outline?.[1]?.reply).toBeUndefined()
  })

  test('题面与回复截断成预览', () => {
    const page = projectHistoryPage([user('问'.repeat(500), 0), assistant('答'.repeat(900), 10)], null)
    const [entry] = page.outline ?? []
    expect(entry?.prompt.length).toBe(201)
    expect(entry?.prompt.endsWith('…')).toBe(true)
    expect(entry?.reply?.length).toBe(281)
  })

  test('throughTurnId：一次往前覆盖到目标那一轮（含），hasMoreOlder 照实给', () => {
    const messages = rounds(100)
    /* 屏幕上已有 t81..t100，跳到第 7 轮：一页给 t7..t80。 */
    const page = projectHistoryPage(messages, 't81', { throughTurnId: 't7' })
    expect(prompts(page)[0]).toBe('问 7')
    expect(prompts(page).at(-1)).toBe('问 80')
    expect(page.hasMoreOlder).toBe(true)

    const all = projectHistoryPage(messages, 't81', { throughTurnId: 't1' })
    expect(prompts(all).length).toBe(80)
    expect(all.hasMoreOlder).toBe(false)
  })

  test('throughTurnId 比一页还近、或认不出：退回普通的一页', () => {
    const messages = rounds(100)
    expect(prompts(projectHistoryPage(messages, 't81', { throughTurnId: 't75' }))[0]).toBe('问 61')
    expect(prompts(projectHistoryPage(messages, 't81', { throughTurnId: 'bogus' }))[0]).toBe('问 61')
  })
})
