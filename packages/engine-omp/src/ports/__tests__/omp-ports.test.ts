import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { noopLogger } from '@poietica/foundation'
import { dataLayout } from '@poietica/runtime-layout'
import type { OmpModelRegistry } from '../../omp-context'
import { hashMediaRef } from '../../projector/media'
import { ompPorts } from '../omp-ports'

/*
 * 组合根这一层的两条硬要求（都在真机上翻过车）：
 *
 * 1. `reload` 回调必须调**真实存在**的方法。omp 的 ModelRegistry 没有 `reload()`（旧代码
 *    `registry.reload?.()` 每次都静默落到 undefined），于是写完 models.yml 之后目录不更新：
 *    用户手动加的服务商在「模型」页里要等重启才出现（omp 知识 #18）。
 * 2. `providers()` 的 configured 要跟 omp 自己的鉴权判据同源（见 models.ts 的端口注释）。
 */

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempLayout() {
  const root = mkdtempSync(path.join(tmpdir(), 'poietica-omp-ports-'))
  made.push(root)
  return dataLayout(root)
}

/** 一个只记「谁被调过」的 registry 替身：端口要调的方法必须是真实存在的那几个（omp 知识 #18）。 */
function registryOf(): { registry: OmpModelRegistry; calls: string[] } {
  const calls: string[] = []
  const registry: OmpModelRegistry = {
    getAll: () => [],
    getAvailable: () => [],
    find: () => undefined,
    hasConfiguredAuth: () => false,
    hydrateCredentialScopedModelCaches: async () => undefined,
    refreshIfStale: async () => {
      calls.push('refreshIfStale')
      return true
    },
    refreshInBackground: () => {
      calls.push('refreshInBackground')
    },
    refreshProvider: async (providerId) => {
      calls.push(`refreshProvider:${providerId}`)
    },
  }
  return { registry, calls }
}

async function portsOf(): Promise<{
  models: Awaited<ReturnType<typeof ompPorts>>['models']
  calls: string[]
}> {
  const { registry, calls } = registryOf()
  const ports = await ompPorts({
    layout: tempLayout(),
    logger: noopLogger,
    root: Settings.isolated(),
    registry,
    authStorage: {
      credentials: {
        has: () => false,
        set: async () => undefined,
        remove: async () => undefined,
      },
    },
    mcpManagers: () => [],
    mediaRef: hashMediaRef,
  })
  return { models: ports.models, calls }
}

describe('ompPorts 的 reload 回调', () => {
  test('写完自定义服务商后按 mtime 重读目录', async () => {
    const { models, calls } = await portsOf()
    await models.upsertCustomProvider({
      id: 'mine',
      name: 'Mine',
      api: 'openai-completions',
      baseUrl: 'https://mine.test/v1',
      models: [{ id: 'm1', name: 'M1', contextWindow: null, reasoning: false, vision: false }],
    })
    expect(calls).toContain('refreshIfStale')
  })

  test('写掉 key 之后也重读（凭据换了目录要跟着重算）', async () => {
    const { models, calls } = await portsOf()
    await models.setApiKey('anthropic', 'sk-test')
    expect(calls).toContain('refreshIfStale')
  })
})
