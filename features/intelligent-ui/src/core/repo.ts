import type { ModuleDatabase } from '@poietica/storage-sqlite'

export interface StateRow {
  readonly callId: string
  readonly title: string
  readonly modelJson: string | null
  readonly viewJson: string | null
  readonly tweaksJson: string | null
  readonly modelRevision: number
  /** 取出这一行时已交到哪一版：交出之后又没送到（排队项被丢弃 / 撤回）要退回这里 */
  readonly deliveredRevision: number
  readonly updatedAt: number
}

export interface StoredState {
  readonly modelJson: string | null
  readonly viewJson: string | null
  readonly tweaksJson: string | null
}

/** 还没交给模型的那几行（model 或 tweaks 非空、版本比上次交出的新），按写入先后排 */
export function createStatesRepo(db: ModuleDatabase) {
  const select = db.prepare(
    `SELECT model_json AS modelJson, view_json AS viewJson, tweaks_json AS tweaksJson
FROM intelligent_ui_states WHERE thread_id = ? AND call_id = ?`,
  )
  /* SET 里的表达式读的都是更新前的值：CASE 比的是旧的 model_json / tweaks_json 与新值 */
  const upsert = db.prepare(`INSERT INTO intelligent_ui_states
  (thread_id, call_id, title, model_json, view_json, tweaks_json, model_revision, delivered_revision, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?4 IS NULL AND ?6 IS NULL THEN 0 ELSE 1 END, 0, ?7)
ON CONFLICT (thread_id, call_id) DO UPDATE SET
  title = excluded.title,
  model_json = excluded.model_json,
  view_json = excluded.view_json,
  tweaks_json = excluded.tweaks_json,
  model_revision = CASE
    WHEN intelligent_ui_states.model_json IS excluded.model_json
      AND intelligent_ui_states.tweaks_json IS excluded.tweaks_json
    THEN intelligent_ui_states.model_revision ELSE intelligent_ui_states.model_revision + 1 END,
  updated_at = excluded.updated_at`)
  const pending = db.prepare(`SELECT call_id AS callId, title, model_json AS modelJson, view_json AS viewJson,
  tweaks_json AS tweaksJson, model_revision AS modelRevision, delivered_revision AS deliveredRevision,
  updated_at AS updatedAt
FROM intelligent_ui_states
WHERE thread_id = ? AND (model_json IS NOT NULL OR tweaks_json IS NOT NULL) AND delivered_revision < model_revision
ORDER BY updated_at, call_id
LIMIT ?`)
  /* 只往前推：交出之后又被改过的那一版（revision 更大）仍然算没交 */
  const deliver = db.prepare(`UPDATE intelligent_ui_states SET delivered_revision = ?3
WHERE thread_id = ?1 AND call_id = ?2 AND delivered_revision < ?3`)
  /* 只退自己记的那一笔：之后又有一句把它交出去了（delivered_revision 已不是这一版），就不动 */
  const undeliver = db.prepare(`UPDATE intelligent_ui_states SET delivered_revision = ?4
WHERE thread_id = ?1 AND call_id = ?2 AND delivered_revision = ?3`)
  const removeThread = db.prepare('DELETE FROM intelligent_ui_states WHERE thread_id = ?')
  const threadIds = db.prepare<{ threadId: string }>('SELECT DISTINCT thread_id AS threadId FROM intelligent_ui_states')

  return {
    get(threadId: string, callId: string): StoredState | null {
      return (select.get(threadId, callId) as StoredState | null) ?? null
    },
    put(
      r: {
        readonly threadId: string
        readonly callId: string
        readonly title: string
        readonly at: number
      } & StoredState,
    ): void {
      upsert.run(r.threadId, r.callId, r.title, r.modelJson, r.viewJson, r.tweaksJson, r.at)
    },
    pending(threadId: string, limit: number): readonly StateRow[] {
      return pending.all(threadId, limit) as StateRow[]
    },
    markDelivered(
      threadId: string,
      rows: readonly { readonly callId: string; readonly modelRevision: number }[],
    ): void {
      for (const row of rows) deliver.run(threadId, row.callId, row.modelRevision)
    },
    /** 撤销 markDelivered：交出的那一句最后没送到 */
    markUndelivered(
      threadId: string,
      rows: readonly { readonly callId: string; readonly modelRevision: number; readonly deliveredRevision: number }[],
    ): void {
      for (const row of rows) undeliver.run(threadId, row.callId, row.modelRevision, row.deliveredRevision)
    },
    removeThread(threadId: string): void {
      removeThread.run(threadId)
    },
    threadIds(): readonly string[] {
      return threadIds.all().map((row) => row.threadId)
    },
  }
}

export type StatesRepo = ReturnType<typeof createStatesRepo>
