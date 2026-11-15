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
    const query = (input: {
      threadId: string
      kinds?: readonly AuditKind[] | undefined
      limit?: number | undefined
    }) => {
      const selected = input.kinds ?? ALL_KINDS
      const types = [...new Set(selected.flatMap((kind) => TYPES[kind]))]
      return journal.readTyped(input.threadId, 'main', types, input.limit ?? 500).map((event) => ({
        seq: event.seq ?? 0,
        type: event.type,
        at: event.at,
        event,
      }))
    }

    ctx.rpc.handle('audit.query', (input) => ({ entries: query(input) }))
    ctx.rpc.handle('audit.export', (input) => {
      const entries = query(input)
      return {
        count: entries.length,
        json: JSON.stringify(
          { threadId: input.threadId, exportedAt: new Date(ctx.clock.now()).toISOString(), entries },
          null,
          2,
        ),
      }
    })
  },
})
