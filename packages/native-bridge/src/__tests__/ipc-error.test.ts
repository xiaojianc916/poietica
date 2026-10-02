/*
 * 跨边界的那句人话。
 *
 * Electron 的 IPC 会把异常压成一句 message，所以 preload 抛的是
 * \`Error('poietica: <code>')\` 挂着 \`problem\` 裸对象（apps/desktop/electron/preload.ts:72）。
 * throughIpc 只认裸对象的话，它落进「认不出来」那一支，屏幕上是
 * \`Error: poietica: agentRejected\` 这样一句码 —— 真正说明原因的 details.reason 与
 * 文案目录键全丢。这一条钉住：**挂在异常上的那一份也要认**，且折出来的 message 是人话。
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
