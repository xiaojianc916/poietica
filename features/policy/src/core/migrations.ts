import type { Migration } from '@poietica/storage-sqlite'

/**
 * 工具放行记录（§13.1 的授权范围）。当前只有「本会话」一档：同一 sessionKey + toolName
 * 在 24 小时内不再询问；撤销即删行。记录只存产品事实，不存凭据。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'grants',
    sql: `CREATE TABLE policy_grants (
  id          TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  UNIQUE (session_key, tool_name)
);
CREATE INDEX policy_grants_by_expiry ON policy_grants (expires_at);`,
  },
]
