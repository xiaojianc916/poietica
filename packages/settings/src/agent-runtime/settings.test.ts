import { expect, test } from 'bun:test'
import type { AgentConfigRecord } from '@poietica/contract/settings'
import type { AgentConfigurationRepository } from './repository'
import { createAgentSettings } from './settings'

const record: AgentConfigRecord = { agents: [], defaultAgentId: 'omp', issues: [] }

function repository(
  load: AgentConfigurationRepository['load'],
  saveAgents: AgentConfigurationRepository['saveAgents'] = async () => record,
): AgentConfigurationRepository {
  return { load, saveAgents }
}

test('读取在飞时不重复问 agent，落地后下一次才重来', async () => {
  let calls = 0
  let resolve!: (record: AgentConfigRecord) => void
  const pending = new Promise<AgentConfigRecord>((done) => {
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

  resolve(record)
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
      async () => record,
      async () => {
        writes += 1
        return record
      },
    ),
  )

  await store.load()

  expect(writes).toBe(1)
  store.dispose()
})

test('dispose 之后的读取当场被拒', () => {
  const store = createAgentSettings(repository(async () => record))

  store.dispose()

  expect(() => store.load()).toThrow('disposed')
})
