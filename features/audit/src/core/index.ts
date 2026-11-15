import type { AgentEvent } from '@poietica/agent-model'
import { defineCoreModule } from '@poietica/core-kernel'
import { JournalServiceToken } from '@poietica/feature-journal/core-api'
import { type AuditKind, auditContract } from '../contract'

const TYPES: Readonly<Record<AuditKind, readonly AgentEvent['type'][]>> = {
  policy: ['policy.decided'],
  approval: ['interaction.requested', 'interaction.resolved'],
  checkpoint: ['checkpoint.created'],
  run: ['run.started', 'run.completed'],
}

const ALL_KINDS = Object.keys(TYPES) as AuditKind[]

export default defineCoreModule({
  id: 'audit',
  contract: auditContract,
  dependsOn: ['journal'],
  setup(ctx) {
    const journal = ctx.services.get(JournalServiceToken)
    ctx.rpc.handle('audit.query', ({ threadId, kinds, limit }) => {
      const selected = kinds ?? ALL_KINDS
      const types = [...new Set(selected.flatMap((kind) => TYPES[kind]))]
      const entries = journal.readTyped(threadId, 'main', types, limit ?? 500).map((event) => ({
        seq: event.seq ?? 0,
        type: event.type,
        at: event.at,
        event,
      }))
      return { entries }
    })
  },
})
