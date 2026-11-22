import type { ModuleDatabase } from '@poietica/storage-sqlite'
import { type Automation, type AutomationDraft, type AutomationRun, ScheduleRule } from '../contract/entities'

export const RUN_HISTORY_LIMIT = 50

/** 认领超过该时长仍未被派发/释放，视为持有者已崩溃，下一轮回收。 */
export const CLAIM_STALE_MS = 10 * 60_000
/** 派发失败退避：30 秒起、15 分钟封顶、最多 5 次。 */
export const DISPATCH_RETRY_BASE_MS = 30_000
export const DISPATCH_RETRY_CAP_MS = 15 * 60_000
export const DISPATCH_MAX_ATTEMPTS = 5
/** 全库保留的任务定义上限；所有状态都占名额，删除才释放。 */
export const AUTOMATION_CREATE_LIMIT = 20

interface AutomationRow {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly cron: string | null
  readonly runAt: number | null
  readonly scheduleRule: string | null
  readonly timeZone: string
  readonly maxRuns: number | null
  readonly endAt: number | null
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
  readonly runCount: number
  readonly dispatchStatus: string
  readonly dispatchAttempts: number
  readonly retryAt: number | null
  readonly lastError: string | null
  readonly claimedAt: number | null
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
  readonly dispatchStatus: AutomationRun['dispatchStatus']
  readonly attempts: number
}

const AUTOMATION_COLUMNS = `id, title, prompt, cron, run_at AS runAt, schedule_rule AS scheduleRule,
  time_zone AS timeZone, max_runs AS maxRuns, end_at AS endAt,
  workspace_id AS workspaceId, posture, model_provider AS modelProvider, model_id AS modelId, thinking,
  thread_mode AS threadMode, thread_id AS threadId, notify, catch_up AS catchUp,
  enabled, next_run_at AS nextRunAt, issue, run_count AS runCount, dispatch_status AS dispatchStatus,
  dispatch_attempts AS dispatchAttempts, retry_at AS retryAt, last_error AS lastError, claimed_at AS claimedAt,
  created_at AS createdAt, updated_at AS updatedAt`

const RUN_COLUMNS = `id, automation_id AS automationId, thread_id AS threadId, triggered_by AS trigger,
  scheduled_for AS scheduledFor, started_at AS startedAt, settled_at AS settledAt, outcome, message,
  summary, attention, dispatch_status AS dispatchStatus, attempts`

/** 规则损坏时退回 cron/at：宁可按兼容展示跑，也不让整条任务读不出来。 */
function ruleOf(raw: string | null): Automation['schedule']['rule'] {
  if (raw === null) return null
  try {
    const parsed = ScheduleRule.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function toAutomation(row: AutomationRow, lastRun: AutomationRun | null): Automation {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    schedule: { cron: row.cron, at: row.runAt, timeZone: row.timeZone, rule: ruleOf(row.scheduleRule) },
    workspaceId: row.workspaceId,
    posture: row.posture as Automation['posture'],
    model: row.modelProvider === null || row.modelId === null ? null : { provider: row.modelProvider, id: row.modelId },
    thinking: row.thinking,
    threadMode: row.threadMode as Automation['threadMode'],
    threadId: row.threadId,
    notify: row.notify as Automation['notify'],
    catchUp: row.catchUp === 1,
    maxRuns: row.maxRuns,
    endAt: row.endAt,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nextRunAt: row.nextRunAt,
    issue: row.issue,
    runCount: row.runCount,
    dispatchStatus: row.dispatchStatus as Automation['dispatchStatus'],
    dispatchAttempts: row.dispatchAttempts,
    retryAt: row.retryAt,
    lastError: row.lastError,
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
    dispatchStatus: row.dispatchStatus,
    attempts: row.attempts,
  }
}

export interface DispatchFailure {
  readonly failedAt: number
  readonly error: string
  readonly kind: 'transient' | 'permanent'
  /** 放弃本轮后的下一个正常窗口；null 表示没有下一次。 */
  readonly nextRunAt: number | null
}

export interface AutomationsRepository {
  count(): number
  list(): Automation[]
  get(id: string): Automation | null
  create(id: string, draft: AutomationDraft, now: number): Automation
  update(id: string, draft: AutomationDraft, now: number): Automation | null
  setNextRun(id: string, nextRunAt: number | null, now: number): void
  setIssue(id: string, issue: string | null, now: number): void
  setEnabled(id: string, enabled: boolean, now: number): void
  setThread(id: string, threadId: string | null, now: number): void
  clearThread(threadId: string, now: number): number
  remove(id: string): void
  removeByWorkspace(workspaceId: string): void
  claimDue(now: number): Automation[]
  releaseClaim(id: string, now: number): void
  clearClaims(now: number): void
  markDispatched(id: string, input: { readonly dispatchedAt: number; readonly nextRunAt: number | null }): void
  markSkipped(
    id: string,
    input: { readonly at: number; readonly nextRunAt: number | null; readonly finalize?: boolean },
  ): void
  markDispatchFailed(id: string, failure: DispatchFailure): void
  resetDispatch(id: string, now: number): void
  insertRunIfAbsent(run: AutomationRun): boolean
  updateRun(run: AutomationRun): void
  getRun(runId: string): AutomationRun | null
  runs(automationId: string, limit: number): AutomationRun[]
  latestRun(automationId: string): AutomationRun | null
  openRun(automationId: string): AutomationRun | null
  openRunsByThread(threadId: string): AutomationRun[]
  allOpenRuns(): AutomationRun[]
  failOpenRuns(message: string, settledAt: number): void
  listEnabled(): Automation[]
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

  const clearClaimSql = `UPDATE automations_automations SET claimed_at = NULL,
      dispatch_status = CASE WHEN dispatch_status = 'claimed' THEN 'idle' ELSE dispatch_status END,
      updated_at = ?
    WHERE id = ?`

  return {
    count() {
      const row = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM automations_automations').get() as { n: number }
      return row.n
    },
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
          (id, title, prompt, cron, run_at, schedule_rule, time_zone, max_runs, end_at, workspace_id, posture,
           model_provider, model_id, thinking, thread_mode, thread_id, notify, catch_up, enabled, next_run_at, issue,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`,
      ).run(
        id,
        draft.title,
        draft.prompt,
        draft.schedule.cron,
        draft.schedule.at,
        draft.schedule.rule == null ? null : JSON.stringify(draft.schedule.rule),
        draft.schedule.timeZone,
        draft.maxRuns ?? null,
        draft.endAt ?? null,
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
             title = ?, prompt = ?, cron = ?, run_at = ?, schedule_rule = ?, time_zone = ?, max_runs = ?, end_at = ?,
             workspace_id = ?, posture = ?, model_provider = ?, model_id = ?, thinking = ?, thread_mode = ?,
             thread_id = ?, notify = ?, catch_up = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          draft.title,
          draft.prompt,
          draft.schedule.cron,
          draft.schedule.at,
          draft.schedule.rule == null ? null : JSON.stringify(draft.schedule.rule),
          draft.schedule.timeZone,
          draft.maxRuns ?? null,
          draft.endAt ?? null,
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
    claimDue(now) {
      return db.transaction(() => {
        /* 截止时刻已过：先停用，避免被本轮或下一轮正常窗口再认领。 */
        db.prepare(
          `UPDATE automations_automations SET enabled = 0, next_run_at = NULL, retry_at = NULL,
             claimed_at = NULL, dispatch_status = 'idle', updated_at = ?
           WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < ?`,
        ).run(now, now)
        // 持有者崩溃留下的认领：超过 CLAIM_STALE_MS 没人结算才允许回收。
        db.prepare(
          `UPDATE automations_automations SET claimed_at = NULL, dispatch_status = 'idle', updated_at = ?
           WHERE claimed_at IS NOT NULL AND claimed_at <= ?`,
        ).run(now, now - CLAIM_STALE_MS)
        const rows = db
          .prepare<AutomationRow>(
            `SELECT ${AUTOMATION_COLUMNS} FROM automations_automations
             WHERE enabled = 1 AND issue IS NULL AND claimed_at IS NULL
               AND (
                 (retry_at IS NOT NULL AND retry_at <= ?)
                 OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?)
               )
             ORDER BY COALESCE(retry_at, next_run_at)`,
          )
          .all(now, now) as AutomationRow[]
        const claim = db.prepare(
          `UPDATE automations_automations
           SET claimed_at = ?, dispatch_status = 'claimed', updated_at = ?
           WHERE id = ? AND claimed_at IS NULL`,
        )
        const claimed: Automation[] = []
        for (const row of rows) {
          if (claim.run(now, now, row.id).changes === 1) {
            claimed.push(read({ ...row, claimedAt: now, dispatchStatus: 'claimed' }))
          }
        }
        return claimed
      })
    },
    releaseClaim(id, now) {
      db.prepare(clearClaimSql).run(now, id)
    },
    clearClaims(now) {
      db.prepare(
        `UPDATE automations_automations SET claimed_at = NULL,
           dispatch_status = CASE WHEN dispatch_status = 'claimed' THEN 'idle' ELSE dispatch_status END,
           updated_at = ?
         WHERE claimed_at IS NOT NULL`,
      ).run(now)
    },
    markDispatched(id, input) {
      db.prepare(
        `UPDATE automations_automations SET
           claimed_at = NULL, dispatch_status = 'dispatched', dispatch_attempts = 0, retry_at = NULL,
           last_error = NULL, run_count = run_count + 1, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.nextRunAt, input.dispatchedAt, id)
    },
    markSkipped(id, input) {
      db.prepare(
        `UPDATE automations_automations SET
           claimed_at = NULL, dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
           last_error = NULL, next_run_at = ?, enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
           updated_at = ?
         WHERE id = ?`,
      ).run(input.nextRunAt, input.finalize === true ? 1 : 0, input.at, id)
    },
    markDispatchFailed(id, failure) {
      const row = db
        .prepare<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations_automations WHERE id = ?`)
        .get(id) as AutomationRow | null
      if (row === null) return
      const attempts = row.dispatchAttempts + 1
      const exhausted = attempts >= DISPATCH_MAX_ATTEMPTS
      const giveUp = failure.kind === 'permanent' || exhausted
      if (giveUp) {
        const hasNext = failure.kind === 'transient' && exhausted && failure.nextRunAt !== null
        // 循环任务重试耗尽：放弃本轮，跳下一个正常窗口；一次性/永久失败：停用等人工处理。
        db.prepare(
          `UPDATE automations_automations SET
             claimed_at = NULL, dispatch_status = ?, dispatch_attempts = ?, retry_at = NULL,
             last_error = ?, next_run_at = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          hasNext ? 'idle' : 'failed_to_dispatch',
          hasNext ? 0 : attempts,
          failure.error,
          failure.nextRunAt,
          hasNext ? row.enabled : 0,
          failure.failedAt,
          id,
        )
        return
      }
      const delay = Math.min(DISPATCH_RETRY_BASE_MS * 2 ** (attempts - 1), DISPATCH_RETRY_CAP_MS)
      // next_run_at 保持不变：重试复用同一个 runId，也不会绕过退避。
      db.prepare(
        `UPDATE automations_automations SET
           claimed_at = NULL, dispatch_status = 'failed_to_dispatch', dispatch_attempts = ?,
           retry_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(attempts, failure.failedAt + delay, failure.error, failure.failedAt, id)
    },
    resetDispatch(id, now) {
      db.prepare(
        `UPDATE automations_automations SET
           claimed_at = NULL, dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
           last_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(now, id)
    },
    insertRunIfAbsent(run) {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO automations_runs
            (id, automation_id, thread_id, triggered_by, scheduled_for, started_at, settled_at, outcome, message,
             summary, attention, dispatch_status, attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
          run.dispatchStatus,
          run.attempts,
        )
      return result.changes === 1
    },
    updateRun(run) {
      db.prepare(
        `UPDATE automations_runs SET thread_id = ?, scheduled_for = ?, settled_at = ?, outcome = ?, message = ?,
           summary = ?, attention = ?, dispatch_status = ?, attempts = ?
         WHERE id = ?`,
      ).run(
        run.threadId,
        run.scheduledFor,
        run.settledAt,
        run.outcome,
        run.message,
        run.summary,
        run.attention ? 1 : 0,
        run.dispatchStatus,
        run.attempts,
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
    trimRuns(automationId) {
      /*
       * 只裁**已收口**的行：`running` / `awaiting` 是「这个任务正在跑」的唯一依据（runner.isRunning 读 openRun），
       * 裁掉它 = 下一次 tick 认为没在跑 → 同一任务并发开第二个运行，且原运行的超时看护（poll）随之撤销。
       * 高频表达式（`* * * * *`）+ 一条等批准的运行，每分钟一条 `skipped`，50 分钟就够把那条 running 挤出前 50。
       */
      db.prepare(
        `DELETE FROM automations_runs
         WHERE automation_id = ? AND outcome NOT IN ('running', 'awaiting') AND id NOT IN (
           SELECT id FROM automations_runs
           WHERE automation_id = ? AND outcome NOT IN ('running', 'awaiting')
           ORDER BY started_at DESC LIMIT ?
         )`,
      ).run(automationId, automationId, RUN_HISTORY_LIMIT)
    },
  }
}
