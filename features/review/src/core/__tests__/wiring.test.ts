import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CoreModuleContext } from '@poietica/core-kernel'
import type { CoreEvent } from '@poietica/core-kernel/events'
import {
  ConversationServiceToken,
  threadRemoved as threadRemovedEvent,
  turnFileChanged,
} from '@poietica/feature-conversation/core-api'
import { WorkspacesServiceToken } from '@poietica/feature-workspaces/core-api'
import { DisposableStore } from '@poietica/foundation'
import { openDatabase, runMigrations } from '@poietica/storage-sqlite'
import { createTestLogger, fakeClock, tempDir } from '@poietica/test-kit'
import { reviewContract } from '../../contract'
import review from '../index'
import { migrations } from '../migrations'

/*
 * 模块装配：migrations 挂上了、订阅挂上了、三个 handler 注册上了。
 *
 * 这里不用整个内核（那要 engine-testkit 与几个别的功能的 core），只把 setup 收到的 ctx 做小：
 * 事实总线、服务表、RPC 注册表各一个假的 —— 要钉的正是「review 有没有把自己接进那三条线」。
 */

interface Wiring {
  readonly root: string
  call(name: string, params: unknown): Promise<unknown>
  emitFileChanged(fact: {
    threadId: string
    turn: number
    path: string
    before: string | null
    after: string | null
  }): void
  emitThreadRemoved(threadId: string): void
  dispose(): Promise<void>
}

async function wire(
  opts: {
    readonly threadRemoved?: CoreEvent<{ threadId: string }>
    /** 假 conversation 认得的线程：给了就让这条线程「还在」 */
    readonly threads?: readonly string[]
  } = {},
): Promise<Wiring> {
  const dir = await tempDir('review-wiring-')
  const db = openDatabase(':memory:')
  runMigrations(db, [{ moduleId: 'review', migrations }])
  const handlers = new Map<string, (params: never) => unknown>()
  const listeners = new Map<CoreEvent<unknown>, Set<(payload: unknown) => void>>()
  const disposables = new DisposableStore()
  const clock = fakeClock()

  /* 线程 → 工作区：假 conversation 只回答这一件事（get 回 null = 线程已删） */
  const threads = new Map<string, { workspaceId: string }>(
    (opts.threads ?? []).map((threadId) => [threadId, { workspaceId: 'w1' }]),
  )
  const threadRemovedEvent = opts.threadRemoved

  const ctx = {
    moduleId: 'review',
    logger: createTestLogger(),
    clock,
    db: db.forModule('review'),
    rpc: {
      handle: (name: string, fn: (params: never) => unknown) => {
        handlers.set(name, fn)
        return { dispose: () => undefined }
      },
      emit: () => undefined,
    },
    host: { call: () => Promise.reject(new Error('Host 不在测试里')) },
    services: {
      get: (token: { ownerModule: string }) => {
        if (token === WorkspacesServiceToken) {
          return {
            get: (id: string) =>
              id === 'w1' ? { id: 'w1', path: dir.path, name: 'w', createdAt: 0, lastOpenedAt: 0, exists: true } : null,
            requireUsable: (id: string) => {
              if (id !== 'w1') throw new Error('没有这个工作区')
              return { id, path: dir.path, name: 'w', createdAt: 0, lastOpenedAt: 0, exists: true }
            },
            list: () => [],
          }
        }
        if (token === ConversationServiceToken) {
          return {
            createThread: () => {
              throw new Error('不属于这条测试')
            },
            submit: () => Promise.resolve(),
            cancel: () => Promise.resolve(),
            get: (threadId: string) => threads.get(threadId) ?? null,
          }
        }
        throw new Error('没有这个服务')
      },
    },
    events: {
      emit: (event: CoreEvent<unknown>, payload: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(payload)
      },
      on: (event: CoreEvent<unknown>, handler: (payload: unknown) => void) => {
        const set = listeners.get(event) ?? new Set()
        set.add(handler)
        listeners.set(event, set)
        return { dispose: () => set.delete(handler) }
      },
    },
    agentTools: { register: () => ({ dispose: () => undefined }) },
    runtime: { coreVersion: 'test', engineVersion: 'test', scrubbedEnvKeys: [], setLogLevel: () => undefined },
    lifecycle: { onReady: () => undefined, onShutdown: () => undefined },
    disposables,
  } as unknown as CoreModuleContext

  await review.setup(ctx)

  return {
    root: dir.path,
    call: async (name, params) => {
      const handler = handlers.get(name)
      if (handler === undefined) throw new Error(`这个 handler 没有注册：${name}`)
      return await handler(params as never)
    },
    emitFileChanged: (fact) => {
      for (const listener of listeners.get(turnFileChanged as CoreEvent<unknown>) ?? []) listener(fact)
    },
    emitThreadRemoved: (threadId) => {
      if (threadRemovedEvent === undefined) return
      for (const listener of listeners.get(threadRemovedEvent as CoreEvent<unknown>) ?? []) listener({ threadId })
    },
    async dispose() {
      disposables.dispose()
      db.close()
      await dir.dispose()
    },
  }
}

const fact = {
  threadId: 't1',
  turn: 1,
  path: 'a.txt',
  before: 'old\n',
  after: 'new\n',
}

describe('review 模块装配', () => {
  test('migrations 挂在模块上，且只有一条 init；三个方法与通知都在契约里', () => {
    expect(review.migrations).toBe(migrations)
    expect(migrations).toHaveLength(1)
    expect(review.dependsOn).toEqual(['workspaces', 'conversation'])
    const names = reviewContract.methods.map((m) => m.name)
    expect(names).toContain('review.turnChanges')
    expect(names).toContain('review.previewTurnRewind')
    expect(names).toContain('review.applyTurnRewind')
    expect(reviewContract.notifications.map((n) => n.name)).toContain('review.turnChangesChanged')
  })

  test('三个方法都注册了；没有账时 turnChanges 报空、preview 报 rewind_not_available', async () => {
    const w = await wire()
    expect(await w.call('review.turnChanges', { threadId: 't1' })).toEqual({ turns: [] })
    const error = await w.call('review.previewTurnRewind', { threadId: 't1', turn: 1 }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(error?.code).toBe('review.rewind_not_available')
    await w.dispose()
  })

  test('turnFileChanged 落账：路径按工作区根解析，读出来是相对路径；三个方法都读得到', async () => {
    const w = await wire({ threads: ['t1'] })
    await fs.writeFile(path.join(w.root, 'a.txt'), 'new\n', 'utf8')
    w.emitFileChanged(fact)

    const changes = (await w.call('review.turnChanges', { threadId: 't1' })) as {
      turns: {
        turn: number
        fileCount: number
        added: number
        removed: number
        reverted: boolean
        files: { path: string }[]
      }[]
    }
    expect(changes.turns).toHaveLength(1)
    expect(changes.turns[0]).toMatchObject({ turn: 1, fileCount: 1, added: 1, removed: 1, reverted: false })
    expect(changes.turns[0]?.files[0]?.path).toBe('a.txt')

    const preview = (await w.call('review.previewTurnRewind', { threadId: 't1', turn: 1 })) as {
      safe: { path: string }[]
      unsafe: unknown[]
      canApply: boolean
    }
    expect(preview.canApply).toBe(true)
    expect(await w.call('review.applyTurnRewind', { threadId: 't1', turn: 1 })).toEqual({ turn: 1, reverted: true })
    expect(await fs.readFile(path.join(w.root, 'a.txt'), 'utf8')).toBe('old\n')
    await w.dispose()
  })

  test('线程已删：这一笔丢弃（没有主人），不抛', async () => {
    const w = await wire()
    w.emitFileChanged({ ...fact, threadId: 'gone' })
    expect(await w.call('review.turnChanges', { threadId: 'gone' })).toEqual({ turns: [] })
    await w.dispose()
  })

  test('线程删除事件：它的账一起清掉', async () => {
    const w = await wire({ threads: ['t1'], threadRemoved: threadRemovedEvent })
    await fs.writeFile(path.join(w.root, 'a.txt'), 'new\n', 'utf8')
    w.emitFileChanged(fact)
    expect(((await w.call('review.turnChanges', { threadId: 't1' })) as { turns: unknown[] }).turns).toHaveLength(1)
    w.emitThreadRemoved('t1')
    expect(await w.call('review.turnChanges', { threadId: 't1' })).toEqual({ turns: [] })
    await w.dispose()
  })
})
