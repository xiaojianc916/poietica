import type { AgentTranscriptEvent } from '@poietica/contract'
import type { TranscriptPage, TranscriptSignal } from '@poietica/conversation'
import {
  type TranscriptOperation,
  transcriptOpsPayloadSchema,
  transcriptResetPayloadSchema,
  transcriptResponseSchema,
} from '@poietica/transcript'

type Decoded =
  | { readonly ok: true; readonly signal: TranscriptSignal }
  | { readonly ok: false; readonly error: Error }

export function decodeTranscriptEvent(wire: AgentTranscriptEvent): Decoded {
  try {
    const envelope: unknown = JSON.parse(wire.json)
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      !('type' in envelope) ||
      !('payload' in envelope)
    ) {
      throw new Error('Invalid envelope.')
    }
    if (envelope.type === 'resync_required') {
      const payload = envelope.payload
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('reason' in payload) ||
        typeof payload.reason !== 'string'
      ) {
        throw new Error('Invalid recovery envelope.')
      }
      return {
        ok: true,
        signal: {
          kind: 'resync',
          sessionId: wire.sessionId,
          reason: payload.reason,
        },
      }
    }
    if (envelope.type === 'transcript.reset') {
      const data = transcriptResetPayloadSchema.parse(envelope.payload)
      return {
        ok: true,
        signal: { kind: 'reset', sessionId: wire.sessionId, agentId: data.agent_id },
      }
    }
    if (envelope.type !== 'transcript.ops') {
      throw new Error('Unexpected transcript envelope.')
    }
    const parsed = transcriptOpsPayloadSchema.safeParse(envelope.payload)
    if (!parsed.success) {
      throw new Error('Invalid transcript payload.')
    }
    const data = parsed.data
    if (data.seq === undefined) {
      return {
        ok: true,
        signal: {
          kind: 'resync',
          sessionId: wire.sessionId,
          reason: 'transcript cursor unavailable',
        },
      }
    }
    if (!Number.isSafeInteger(data.seq) || data.seq < 0) {
      throw new Error('Invalid transcript sequence.')
    }
    return {
      ok: true,
      signal: {
        kind: 'ops',
        sessionId: wire.sessionId,
        agentId: data.agent_id,
        seq: data.seq,
        ops: data.ops as readonly TranscriptOperation[],
      },
    }
  } catch {
    // Do not put raw JSON, prompts, or schema input values into diagnostics.
    return { ok: false, error: new Error('Transcript event failed boundary validation.') }
  }
}

export function transcriptPageOf(json: string): TranscriptPage {
  const data = transcriptResponseSchema.parse(JSON.parse(json))
  return {
    agentId: data.agent_id,
    items: data.items,
    hasMoreOlder: data.has_more,
    tasks: data.tasks,
    interactions: data.interactions,
    attachments: data.attachments,
    todos: data.todos,
    prompts: data.prompts,
    meta: data.meta,
    agents: data.agents,
    pendingInteractions: data.pending_interactions,
    seq: data.seq ?? 0,
  } as TranscriptPage
}
