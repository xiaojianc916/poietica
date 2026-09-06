import { expect, test } from 'bun:test'
import type { AgentInstallStatus } from '@poietica/contract/settings'
import type { AgentConfigurationRepository } from './repository'
import { createAgentSettings } from './settings'

function pendingStatus() {
  let resolve!: (status: AgentInstallStatus) => void
  const promise = new Promise<AgentInstallStatus>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const installed: AgentInstallStatus = {
  state: 'current',
  installedVersion: '1',
  latestVersion: '1',
  packageName: 'agent-test',
}
function repository(
  runInstall: AgentConfigurationRepository['runInstall'],
): AgentConfigurationRepository {
  return {
    load: async () => {
      throw new Error('Unexpected configuration read')
    },
    saveAgents: async () => {
      throw new Error('Unexpected configuration write')
    },
    loadInstallStatus: async () => installed,
    runInstall,
  }
}
test('installation requests coalesce per instance, never across instances', async () => {
  const one = pendingStatus()
  const two = pendingStatus()
  let calls = 0
  const first = createAgentSettings(
    repository(() => {
      calls += 1
      return one.promise
    }),
  )
  const second = createAgentSettings(
    repository(() => {
      calls += 1
      return two.promise
    }),
  )
  const a = first.runInstall('agent')
  expect(first.runInstall('agent')).toBe(a)
  const b = second.runInstall('agent')
  expect(b).not.toBe(a)
  expect(calls).toBe(2)
  one.resolve(installed)
  two.resolve(installed)
  await Promise.all([a, b])
  await first.runInstall('agent')
  expect(calls).toBe(3)
  first.dispose()
  second.dispose()
})
test('configuration subscriptions belong to the factory lifecycle', () => {
  const store = createAgentSettings(repository(async () => installed))
  let changes = 0
  const release = store.subscribeConfigChanged(() => {
    changes += 1
  })
  store.notifyConfigChanged()
  expect(changes).toBe(1)
  release()
  store.notifyConfigChanged()
  expect(changes).toBe(1)
  store.subscribeConfigChanged(() => {
    changes += 1
  })
  store.dispose()
  store.notifyConfigChanged()
  expect(changes).toBe(1)
  expect(() => store.subscribeConfigChanged(() => {})).toThrow('disposed')
})
