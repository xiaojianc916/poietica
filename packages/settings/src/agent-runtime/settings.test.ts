import { expect, test } from 'bun:test'
import type { StoredAgentProfile } from './model'
import type { AgentConfigurationRepository } from './repository'
import { createAgentSettings } from './settings'

const stored: StoredAgentProfile = { profile: null, issues: [] }

function repository(
  load: AgentConfigurationRepository['load'],
  save: AgentConfigurationRepository['save'] = async () => stored,
): AgentConfigurationRepository {
  return { load, save }
}

test('读取在飞时不重复问原生，落地后下一次才重来', async () => {
  let calls = 0
  let resolve!: (record: StoredAgentProfile) => void
  const pending = new Promise<StoredAgentProfile>((done) => {
    resolve = done
  })
  const store = createAgentSettings(
    repository(() => {
      calls += 1
      return pending
    }),
  )

  const first = store.load()
  expect(store.load()).toBe(first)
  expect(calls).toBe(1)

  resolve(stored)
  await first
  await store.load()
  expect(calls).toBe(2)

  store.dispose()
})

/* 落盘是启动门禁的那一步：磁盘上还没有档案时，读取要把它写下去。 */
test('磁盘上还没有档案时，读取把它物化下去', async () => {
  let writes = 0
  const store = createAgentSettings(
    repository(
      async () => stored,
      async () => {
        writes += 1
        return stored
      },
    ),
  )

  const snapshot = await store.load()

  expect(writes).toBe(1)
  expect(snapshot.profile.id).toBe('omp')
  store.dispose()
})

test('dispose 之后的读取当场被拒', () => {
  const store = createAgentSettings(repository(async () => stored))

  store.dispose()

  expect(() => store.load()).toThrow('disposed')
})
