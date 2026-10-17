import { describe, expect, test } from 'bun:test'
import type { LoginIO } from '@poietica/engine'
import type { Logger } from '@poietica/foundation'
import type { LoginEvent } from '../../contract'
import { LoginFlows } from '../login-flows'

/* O-04：登录流程全在 omp；Core 只把回调翻成 models.loginEvent、把界面填的格子按 promptId 交回去。 */

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
}

function harness(
  login: (
    providerId: string,
    io: LoginIO,
  ) => Promise<{ kind: 'oauth'; email: string | null; orgName: string | null } | null>,
) {
  const events: { loginId: string; event: LoginEvent }[] = []
  let changed = 0
  const flows = new LoginFlows({
    models: { login },
    logger,
    emit: (loginId, event) => events.push({ loginId, event }),
    emitChanged: () => {
      changed += 1
    },
  })
  return { events, flows, changed: () => changed }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('LoginFlows', () => {
  test('网址 → 要一格 → 答了 → 完成，并通知模型目录变了', async () => {
    const h = harness(async (_id, io) => {
      io.onAuth({ url: 'https://auth', launchUrl: null, code: null, instructions: null })
      const code = await io.onPrompt({
        message: '授权码',
        placeholder: null,
        secret: false,
        allowEmpty: false,
        fallback: false,
      })
      return { kind: 'oauth', email: `${code}@x`, orgName: null }
    })
    const loginId = h.flows.start('anthropic')
    await settle()
    const prompt = h.events.find((e) => e.event.kind === 'prompt')?.event
    if (prompt?.kind !== 'prompt') throw new Error('没有要格子')
    h.flows.answer(loginId, prompt.promptId, 'me')
    await settle()
    expect(h.events.map((e) => e.event.kind)).toEqual(['auth', 'prompt', 'done'])
    expect(h.events.at(-1)?.event).toEqual({ kind: 'done', identity: { kind: 'oauth', email: 'me@x', orgName: null } })
    expect(h.changed()).toBe(1)
  })

  test('取消：信号中止、等着的格子被拒，结局报「登录已取消」，之后答格报 login_not_found', async () => {
    const h = harness(async (_id, io) => {
      await io.onPrompt({ message: '授权码', placeholder: null, secret: false, allowEmpty: false, fallback: true })
      return null
    })
    const loginId = h.flows.start('anthropic')
    await settle()
    h.flows.cancel(loginId)
    await settle()
    expect(h.events.at(-1)?.event).toEqual({ kind: 'failed', message: '登录已取消' })
    expect(() => h.flows.answer(loginId, 'x', 'y')).toThrow()
    expect(h.changed()).toBe(0)
  })
})
