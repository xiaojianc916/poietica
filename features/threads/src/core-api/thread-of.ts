import type { Thread } from '@poietica/product-model'
import type { ThreadRow } from './types'

/**
 * 行 → 实体。state 与 pendingInteraction 都由活会话决定（不在池中即 idle / null），
 * 这里只负责其余字段。
 */
export function threadOf(
  row: ThreadRow,
  state: Thread['state'],
  pendingInteraction: Thread['pendingInteraction'],
): Thread {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    titleSource: row.titleSource,
    posture: row.posture,
    origin: row.origin,
    state,
    pendingInteraction,
    hasSession: row.sessionFile !== null,
    sessionId: row.sessionId,
    forkedFrom: row.forkedFrom,
    pinned: row.pinned,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
