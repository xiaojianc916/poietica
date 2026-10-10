import { createFakeEngine, type FakeEngine, type ScenarioScript } from '@poietica/engine-testkit'
import type { Thread } from '@poietica/feature-conversation/contract'
import type { ConversationService } from '@poietica/feature-conversation/core-api'
import type { Workspace } from '@poietica/feature-workspaces/contract'
import type { WorkspacesService } from '@poietica/feature-workspaces/core-api'
import { createId } from '@poietica/foundation'
import { type Database, openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger, type FakeClock, fakeClock } from '@poietica/test-kit'
import type { AutomationAttention, AutomationDraft, AutomationRun } from '../../contract/entities'
import { migrations } from '../migrations'
import { type AutomationsRepository, createAutomationsRepository } from '../repository'
import { createRunner } from '../runner'
import { createScheduler } from '../scheduler'
import { createAutomationsService } from '../service'

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

/* ── 审查 R-14 / R-15 的新用例共用 ─────────────────────────────── */

/** 一份完整草稿：默认每分钟一次、UTC、工作区 ws1，按需覆盖 */
export function fullDraft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    title: '晨会动态',
    prompt: '汇总进展',
    schedule: { cron: '*/1 * * * *', at: null, timeZone: 'UTC' },
    workspaceId: 'ws1',
    posture: 'auto-edit',
    model: null,
    thinking: null,
    threadMode: 'new',
    threadId: null,
    notify: 'attention',
    catchUp: true,
    ...overrides,
  }
}

/** runner + service + scheduler 全套，外加记下发出去的运行更新与通知 */
export function buildCore(o: { readonly workspaces?: WorkspacesService } = {}) {
  const d = unitDeps(o)
  const logger = createTestLogger()
  const updates: AutomationRun[] = []
  const attentions: AutomationAttention[] = []
  let changed = 0
  const runner = createRunner({
    repo: d.repo,
    conversation: d.conversation,
    workspaces: d.workspaces,
    clock: d.clock,
    logger,
    emitRunUpdated: (run) => updates.push(run),
    emitAttention: (a) => attentions.push(a),
    emitChanged: () => {
      changed++
    },
  })
  const service = createAutomationsService({
    repo: d.repo,
    runner,
    conversation: d.conversation,
    clock: d.clock,
    logger,
  })
  const scheduler = createScheduler({ repo: d.repo, runner, clock: d.clock, logger })
  return { ...d, logger, runner, service, scheduler, updates, attentions, changed: () => changed }
}
