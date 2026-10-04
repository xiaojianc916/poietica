/*
 * 跨边界的那句人话。
 *
 * 两条来源各钉一条：
 * - **裸对象**：preload 走的就是这一条（apps/desktop/electron/preload.ts 的 throw problem）。
 *   contextBridge 过不去 Error 的自定义属性，所以那一层只能抛对象本身；
 * - **挂在异常上的那一份**：进程内调用方按 Object.assign(new Error(...), { problem }) 交过来。
 *   少了这一支，它们拿到的就是一句 \`poietica: agentRejected\` 的码，details.reason 全丢。
 *
 * 自检跑法：bun test src/__tests__/ipc-error.test.ts
 */

import { expect, test } from 'bun:test'
import { ProblemError } from '@poietica/problem'

/* `Problem` 不在包的公开面上（index.ts 只列了它与 ProblemError），从实例上取。 */
type Problem = ProblemError['problem']

import { throughIpc } from '../ipc-error.ts'

const problem: Problem = {
  code: 'agentRejected',
  category: 'protocol',
  retryability: 'no',
  userMessageKey: 'problem.agentRejected',
  diagnosticId: 'diag-1',
  details: { reason: 'agent 拒绝了这次调用' },
}

/** preload.ts:72 抛的那一个形状。 */
const attached = (): Error => Object.assign(new Error('poietica: agentRejected'), { problem })

test('a Problem carried on the thrown error becomes the domain error', async () => {
  const failure = await throughIpc(() => Promise.reject(attached())).catch(
    (cause: unknown) => cause,
  )

  expect(failure).toBeInstanceOf(ProblemError)
  expect((failure as ProblemError).problem).toEqual(problem)
  /* message 是人话（details.reason 优先），不是那一句码。 */
  expect((failure as ProblemError).message).toBe('agent 拒绝了这次调用')
})

test('a bare Problem object still becomes the domain error', async () => {
  const failure = await throughIpc(() => Promise.reject(problem)).catch((cause: unknown) => cause)

  expect(failure).toBeInstanceOf(ProblemError)
  expect((failure as ProblemError).problem).toEqual(problem)
})

/* 认不出来的原样上抛：不许被折成一句「操作失败」。 */
test('an unrecognised failure is rethrown untouched', async () => {
  const raw = new Error('socket closed')

  const failure = await throughIpc(() => Promise.reject(raw)).catch((cause: unknown) => cause)

  expect(failure).toBe(raw)
})
