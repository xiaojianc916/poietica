import { createFakeEngine, type FakeEngine, type ScenarioScript } from '@poietica/engine-testkit'
import type { Thread } from '@poietica/feature-conversation/contract'
import type { ConversationService } from '@poietica/feature-conversation/core-api'
import type { Workspace } from '@poietica/feature-workspaces/contract'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { createId } from '@poietica/foundation'
import { type Database, openDatabase } from '@poietica/storage-sqlite'
import { type FakeClock, fakeClock } from '@poietica/test-kit'
import { migrations } from '../migrations'
import { type AutomationsRepository, createAutomationsRepository } from '../repository'

/** 内存库 + automations 迁移：仓库/服务/调度器的单测共用 */
export function createTestDatabase(): { db: Database; repo: AutomationsRepository } {
  const db = openDatabase(':memory:')
  const moduleDb = db.forModule('automations')
  for (const m of migrations) moduleDb.exec(m.sql!)
  return { db, repo: createAutomationsRepository(moduleDb) }
}

export function testWorkspace(id = 'ws1', path = 'D:/ws'): Workspace {
  return {
    id,
    kind: 'folder',
    path,
    name: id,
    createdAt: 0,
    lastOpenedAt: 0,
    exists: true,
  }
}

export function stubWorkspaces(workspaces: readonly Workspace[] = [testWorkspace()]): WorkspacesService {
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  return {
    get: (id) => byId.get(id) ?? null,
    requireUsable(id) {
      const ws = byId.get(id)
      if (ws === undefined) throw new Error(`workspaces.not_found: ${id}`)
      return ws
    },
    list: () => workspaces,
  }
}

/** 假会话服务：记录创建与提交，状态可被测试直接设定 */
export function stubConversation(): ConversationService & {
  readonly created: { workspaceId: string; title: string }[]
  readonly submitted: { threadId: string; text: string }[]
  readonly cancelled: string[]
  setState(threadId: string, state: Thread['state']): void
} {
  const threads = new Map<string, Thread>()
  const created: { workspaceId: string; title: string }[] = []
  const submitted: { threadId: string; text: string }[] = []
  const cancelled: string[] = []
  return {
    created,
    submitted,
    cancelled,
    createThread(init) {
      const id = createId()
      const thread: Thread = {
        id,
        workspaceId: init.workspaceId,
        title: init.title,
        titleSource: 'user',
        posture: init.posture,
        origin: init.origin,
        state: 'idle',
        hasSession: false,
        forkedFrom: null,
        pinned: false,
        archived: false,
        createdAt: 0,
        updatedAt: 0,
      }
      threads.set(id, thread)
      created.push({ workspaceId: init.workspaceId, title: init.title })
      return thread
    },
    async submit(input) {
      submitted.push(input)
    },
    async cancel(threadId) {
      cancelled.push(threadId)
    },
    get: (threadId) => threads.get(threadId) ?? null,
    setState(threadId, state) {
      const thread = threads.get(threadId)
      if (thread !== undefined) threads.set(threadId, { ...thread, state })
    },
  }
}

export interface UnitDeps {
  readonly db: Database
  readonly repo: AutomationsRepository
  readonly clock: FakeClock
  readonly conversation: ReturnType<typeof stubConversation>
  readonly workspaces: WorkspacesService
}

export function unitDeps(o: { readonly clock?: FakeClock; readonly workspaces?: WorkspacesService } = {}): UnitDeps {
  const { db, repo } = createTestDatabase()
  return {
    db,
    repo,
    clock: o.clock ?? fakeClock(),
    conversation: stubConversation(),
    workspaces: o.workspaces ?? stubWorkspaces(),
  }
}

export function testClock(): FakeClock {
  return fakeClock()
}

export { createFakeEngine, type FakeEngine, type ScenarioScript }
