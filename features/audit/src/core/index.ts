import type { AgentEvent } from '@poietica/agent-model'
import { defineCoreModule } from '@poietica/core-kernel'
import { type JournalQueryOptions, JournalServiceToken } from '@poietica/feature-journal/core-api'
import { type AuditEntry, type AuditFilter, type AuditKind, auditContract } from '../contract'

/**
 * 类别 → Journal 事件类型。审计不另存副本，这里就是「审计页能看到什么」的全部定义。
 * policy.granted / policy.revoked 也归「策略」：放行与撤销同属 §13.5 要留痕的三件事。
 */
const TYPES: Readonly<Record<AuditKind, readonly AgentEvent['type'][]>> = {
  policy: ['policy.decided', 'policy.granted', 'policy.revoked'],
  approval: ['interaction.requested', 'interaction.resolved'],
  checkpoint: ['checkpoint.created'],
  run: ['run.started', 'run.completed'],
}

const ALL_KINDS = Object.keys(TYPES) as AuditKind[]

interface AuditFields {
  readonly toolName?: string
  readonly risk?: string
  readonly workspaceRoot?: string
}

/**
 * 字段条件落到哪些类别上。工具名与风险等级只存在于策略裁决上；工作区裁决与检查点都有。
 * 给了字段条件却不含该字段的类别一并排除 —— 否则「只看 bash 的裁决」会被一堆审批事件淹掉。
 */
const FIELD_KINDS: Readonly<Record<keyof AuditFields, readonly AuditKind[]>> = {
  toolName: ['policy'],
  risk: ['policy'],
  workspaceRoot: ['policy', 'checkpoint'],
}

function fieldsOf(filter: AuditFilter): AuditFields {
  return {
    ...(filter.tool === undefined ? {} : { toolName: filter.tool }),
    ...(filter.risk === undefined ? {} : { risk: filter.risk }),
    ...(filter.workspaceRoot === undefined ? {} : { workspaceRoot: filter.workspaceRoot }),
  }
}

/** 一次查询真正要读的类别：显式选的，再与字段条件支持的范围取交集。 */
function effectiveKinds(filter: AuditFilter): AuditKind[] {
  const selected = filter.kinds ?? ALL_KINDS
  const constrained = Object.keys(fieldsOf(filter)) as (keyof AuditFields)[]
  if (constrained.length === 0) return [...selected]
  const allowed = new Set<AuditKind>(ALL_KINDS)
  for (const name of constrained) {
    const scoped = new Set<AuditKind>(FIELD_KINDS[name])
    for (const kind of [...allowed]) if (!scoped.has(kind)) allowed.delete(kind)
  }
  return selected.filter((kind) => allowed.has(kind))
}

/** 某个类别该带哪些字段条件：只带它真的有那些字段的。 */
function fieldsFor(kind: AuditKind, fields: AuditFields): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (!FIELD_KINDS[name as keyof AuditFields].includes(kind)) continue
    out[name] = value
  }
  return out
}

export default defineCoreModule({
  id: 'audit',
  contract: auditContract,
  dependsOn: ['journal'],
  setup(ctx) {
    const journal = ctx.services.get(JournalServiceToken)

    const query = (filter: AuditFilter): AuditEntry[] => {
      const kinds = effectiveKinds(filter)
      if (kinds.length === 0) return []
      const fields = fieldsOf(filter)
      const limit = filter.limit ?? 500
      const entries: AuditEntry[] = []
      for (const kind of kinds) {
        /* 每个类别都取到全量上限：合起来之后再截断，避免类别之间互相挤掉 */
        const options: JournalQueryOptions = {
          ...(filter.threadId === undefined ? {} : { threadId: filter.threadId }),
          fields: fieldsFor(kind, fields),
          limit,
        }
        for (const row of journal.query(TYPES[kind], options)) {
          entries.push({
            seq: row.event.seq ?? 0,
            type: row.event.type,
            at: row.event.at,
            threadId: row.threadId,
            event: row.event,
          })
        }
      }
      /* 跨线程时按发生时刻排：seq 只在一条线程里可比，拿来跨线程排序是错的 */
      entries.sort((left, right) => (left.at === right.at ? 0 : left.at < right.at ? -1 : 1))
      return entries.length > limit ? entries.slice(0, limit) : entries
    }

    ctx.rpc.handle('audit.query', (filter) => ({ entries: query(filter) }))
    ctx.rpc.handle('audit.export', (filter) => {
      const entries = query(filter)
      return {
        count: entries.length,
        json: JSON.stringify(
          {
            ...(filter.threadId === undefined ? {} : { threadId: filter.threadId }),
            exportedAt: new Date(ctx.clock.now()).toISOString(),
            entries,
          },
          null,
          2,
        ),
      }
    })
  },
})
