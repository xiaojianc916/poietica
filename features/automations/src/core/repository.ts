import type { ModuleDatabase } from '@poietica/storage-sqlite'
import type { Automation, AutomationDraft, AutomationRun } from '../contract/entities'

/** 每个任务只保留最近 50 条运行记录（07 页 §9C「历史上限」） */
export const RUN_HISTORY_LIMIT = 50

interface AutomationRow {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly cron: string | null
  readonly runAt: number | null
  readonly timeZone: string
  readonly workspaceId: string
  readonly posture: string
  readonly modelProvider: string | null
  readonly modelId: string | null
  readonly thinking: string | null
  readonly threadMode: string
  readonly threadId: string | null
  readonly notify: string
  readonly catchUp: number
  readonly enabled: number
  readonly nextRunAt: number | null
  readonly issue: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

interface RunRow {
  readonly id: string
  readonly automationId: string
  readonly threadId: string | null
  readonly trigger: AutomationRun['trigger']
  readonly scheduledFor: number | null
  readonly startedAt: number
  readonly settledAt: number | null
  readonly outcome: AutomationRun['outcome']
  readonly message: string | null
  readonly summary: string | null
  readonly attention: number
}

const AUTOMATION_COLUMNS = `id, title, prompt, cron, run_at AS runAt, time_zone AS timeZone, workspace_id AS workspaceId,
  posture, model_provider AS modelProvider, model_id AS modelId, thinking,
  thread_mode AS threadMode, thread_id AS threadId, notify, catch_up AS catchUp,
  enabled, next_run_at AS nextRunAt, issue, created_at AS createdAt, updated_at AS updatedAt`

const RUN_COLUMNS = `id, automation_id AS automationId, thread_id AS threadId, triggered_by AS trigger,
  scheduled_for AS scheduledFor, started_at AS startedAt, settled_at AS settledAt, outcome, message,
  summary, attention`

function toAutomation(row: AutomationRow, lastRun: AutomationRun | null): Automation {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    schedule: { cron: row.cron, at: row.runAt, timeZone: row.timeZone },
    workspaceId: row.workspaceId,
    posture: row.posture as Automation['posture'],
    model: row.modelProvider === null || row.modelId === null ? null : { provider: row.modelProvider, id: row.modelId },
    thinking: row.thinking,
    threadMode: row.threadMode as Automation['threadMode'],
    threadId: row.threadId,
    notify: row.notify as Automation['notify'],
    catchUp: row.catchUp === 1,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nextRunAt: row.nextRunAt,
    issue: row.issue,
    lastRun,
  }
}

function toRun(row: RunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automationId,
    threadId: row.threadId,
    trigger: row.trigger,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    settledAt: row.settledAt,
    outcome: row.outcome,
    message: row.message,
    summary: row.summary,
    attention: row.attention === 1,
  }
}

export interface AutomationsRepository {
  list(): Automation[]
  get(id: string): Automation | null
  create(id: string, draft: AutomationDraft, now: number): Automation
  update(id: string, draft: AutomationDraft, now: number): Automation | null
  setNextRun(id: string, nextRunAt: number | null, now: number): void
  setIssue(id: string, issue: string | null, now: number): void
  setEnabled(id: string, enabled: boolean, now: number): void
  /** 续用模式第一次运行（或续用的对话没了）新建对话后记下来 */
  setThread(id: string, threadId: string | null, now: number): void
  /** 续用的对话被删：清掉所有指向它的任务，返回清了几个 */
  clearThread(threadId: string, now: number): number
  remove(id: string): void
  removeByWorkspace(workspaceId: string): void
  insertRun(run: AutomationRun): void
  updateRun(run: AutomationRun): void
  getRun(runId: string): AutomationRun | null
  runs(automationId: string, limit: number): AutomationRun[]
  latestRun(automationId: string): AutomationRun | null
  openRun(automationId: string): AutomationRun | null
  openRunsByThread(threadId: string): AutomationRun[]
  allOpenRuns(): AutomationRun[]
  failOpenRuns(message: string, settledAt: number): void
  listEnabled(): Automation[]
  due(now: number): Automation[]
  trimRuns(automationId: string): void
}

export function createAutomationsRepository(db: ModuleDatabase): AutomationsRepository {
  const latest = db.prepare<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM automations_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1`,
  )

  const read = (row: AutomationRow): Automation => {
    const run = latest.get(row.id) as RunRow | null
    return toAutomation(row, run === null ? null : toRun(run))
  }

  const getById = (id: string): Automation | null => {
    const row = db
      .prepare<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations_automations WHERE id = ?`)
      .get(id) as AutomationRow | null
    return row === null ? null : read(row)
  }

  return {
    list() {
      const rows = db
        .prepare<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations_automations ORDER BY created_at DESC`)
        .all() as AutomationRow[]
      return rows.map(read)
    },
    get: getById,
    create(id, draft, now) {
      db.prepare(
        `INSERT INTO automations_automations
          (id, title, prompt, cron, run_at, time_zone, workspace_id, posture, model_provider, model_id, thinking,
           thread_mode, thread_id, notify, catch_up, enabled, next_run_at, issue, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`,
      ).run(
        id,
        draft.title,
        draft.prompt,
        draft.schedule.cron,
        draft.schedule.at,
        draft.schedule.timeZone,
        draft.workspaceId,
        draft.posture,
        draft.model?.provider ?? null,
        draft.model?.id ?? null,
        draft.thinking,
        draft.threadMode,
        draft.threadId,
        draft.notify,
        draft.catchUp ? 1 : 0,
        now,
        now,
      )
      return getById(id)!
    },
    update(id, draft, now) {
      const result = db
        .prepare(
          `UPDATE automations_automations SET
             title = ?, prompt = ?, cron = ?, run_at = ?, time_zone = ?, workspace_id = ?, posture = ?,
             model_provider = ?, model_id = ?, thinking = ?, thread_mode = ?, thread_id = ?, notify = ?,
             catch_up = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          draft.title,
          draft.prompt,
          draft.schedule.cron,
          draft.schedule.at,
          draft.schedule.timeZone,
          draft.workspaceId,
          draft.posture,
          draft.model?.provider ?? null,
          draft.model?.id ?? null,
          draft.thinking,
          draft.threadMode,
          draft.threadId,
          draft.notify,
          draft.catchUp ? 1 : 0,
          now,
          id,
        )
      if (result.changes === 0) return null
      return getById(id)
    },
    setNextRun(id, nextRunAt, now) {
      db.prepare('UPDATE automations_automations SET next_run_at = ?, updated_at = ? WHERE id = ?').run(
        nextRunAt,
        now,
        id,
      )
    },
    setIssue(id, issue, now) {
      db.prepare('UPDATE automations_automations SET issue = ?, updated_at = ? WHERE id = ?').run(issue, now, id)
    },
    setEnabled(id, enabled, now) {
      db.prepare('UPDATE automations_automations SET enabled = ?, updated_at = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        now,
        id,
      )
    },
    setThread(id, threadId, now) {
      db.prepare('UPDATE automations_automations SET thread_id = ?, updated_at = ? WHERE id = ?').run(threadId, now, id)
    },
    clearThread(threadId, now) {
      return db
        .prepare('UPDATE automations_automations SET thread_id = NULL, updated_at = ? WHERE thread_id = ?')
        .run(now, threadId).changes
    },
    remove(id) {
      db.prepare('DELETE FROM automations_automations WHERE id = ?').run(id)
    },
    removeByWorkspace(workspaceId) {
      db.prepare('DELETE FROM automations_automations WHERE workspace_id = ?').run(workspaceId)
    },
    insertRun(run) {
      db.prepare(
        `INSERT INTO automations_runs
          (id, automation_id, thread_id, triggered_by, scheduled_for, started_at, settled_at, outcome, message,
           summary, attention)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.automationId,
        run.threadId,
        run.trigger,
        run.scheduledFor,
        run.startedAt,
        run.settledAt,
        run.outcome,
        run.message,
        run.summary,
        run.attention ? 1 : 0,
      )
    },
    updateRun(run) {
      db.prepare(
        `UPDATE automations_runs SET thread_id = ?, scheduled_for = ?, settled_at = ?, outcome = ?, message = ?,
           summary = ?, attention = ?
         WHERE id = ?`,
      ).run(
        run.threadId,
        run.scheduledFor,
        run.settledAt,
        run.outcome,
        run.message,
        run.summary,
        run.attention ? 1 : 0,
        run.id,
      )
    },
    getRun(runId) {
      const row = db
        .prepare<RunRow>(`SELECT ${RUN_COLUMNS} FROM automations_runs WHERE id = ?`)
        .get(runId) as RunRow | null
      return row === null ? null : toRun(row)
    },
    runs(automationId, limit) {
      const rows = db
        .prepare<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM automations_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?`,
        )
        .all(automationId, limit) as RunRow[]
      return rows.map(toRun)
    },
    latestRun(automationId) {
      const row = latest.get(automationId) as RunRow | null
      return row === null ? null : toRun(row)
    },
    openRun(automationId) {
      const row = db
        .prepare<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM automations_runs
           WHERE automation_id = ? AND outcome IN ('running','awaiting')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(automationId) as RunRow | null
      return row === null ? null : toRun(row)
    },
    openRunsByThread(threadId) {
      const rows = db
        .prepare<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM automations_runs
           WHERE thread_id = ? AND outcome IN ('running','awaiting')`,
        )
        .all(threadId) as RunRow[]
      return rows.map(toRun)
    },
    allOpenRuns() {
      const rows = db
        .prepare<RunRow>(`SELECT ${RUN_COLUMNS} FROM automations_runs WHERE outcome IN ('running','awaiting')`)
        .all() as RunRow[]
      return rows.map(toRun)
    },
    failOpenRuns(message, settledAt) {
      db.prepare(
        `UPDATE automations_runs SET outcome = 'failed', message = ?, settled_at = ?
         WHERE outcome IN ('running','awaiting')`,
      ).run(message, settledAt)
    },
    listEnabled() {
      const rows = db
        .prepare<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations_automations WHERE enabled = 1`)
        .all() as AutomationRow[]
      return rows.map(read)
    },
    due(now) {
      const rows = db
        .prepare<AutomationRow>(
          `SELECT ${AUTOMATION_COLUMNS} FROM automations_automations
           WHERE enabled = 1 AND issue IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
           ORDER BY next_run_at`,
        )
        .all(now) as AutomationRow[]
      return rows.map(read)
    },
    trimRuns(automationId) {
      db.prepare(
        `DELETE FROM automations_runs
         WHERE automation_id = ? AND id NOT IN (
           SELECT id FROM automations_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?
         )`,
      ).run(automationId, automationId, RUN_HISTORY_LIMIT)
    },
  }
}
