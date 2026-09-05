import type { AgentTranscriptEvent } from '@poietica/contract'
import type { TranscriptSignal } from '@poietica/conversation'
import { type TranscriptOperation, transcriptOpsPayloadSchema } from '@poietica/transcript'

type Decoded =
  | { readonly ok: true; readonly signal: TranscriptSignal }
  | { readonly ok: false; readonly error: Error }

/** The native router forwards only transcript.ops and resync_required. */
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
