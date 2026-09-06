import { type AgentSessionEvent, events } from '@poietica/contract'

export interface AgentEventSourceOptions {
  /** Reports a transport failure; listening is best-effort by design. */
  readonly onListenFailure?: (error: unknown) => void
}
type GeneratedEventListener<TPayload> = (
  handler: (payload: TPayload) => void,
) => Promise<() => void>
export function subscribeToEvent<TPayload>(
  listen: GeneratedEventListener<TPayload>,
  handler: (payload: TPayload) => void,
  onListenFailure?: (error: unknown) => void,
): () => void {
  let cancelled = false
  let stop: (() => void) | null = null

  void Promise.resolve()
    .then(() =>
      listen((payload) => {
        if (cancelled) {
          return
        }
        try {
          handler(payload)
        } catch (cause) {
          onListenFailure?.(cause)
        }
      }),
    )
    .then((unlisten) => {
      if (cancelled) {
        unlisten()
        return
      }

      stop = unlisten
    })
    .catch((error: unknown) => {
      if (!cancelled) {
        onListenFailure?.(error)
      }
    })

  return () => {
    cancelled = true
    stop?.()
    stop = null
  }
}
export function subscribeToSessionEvent<TKind extends AgentSessionEvent['kind']>(
  kind: TKind,
  handler: (payload: Extract<AgentSessionEvent, { kind: TKind }>) => void,
  onListenFailure?: (error: unknown) => void,
): () => void {
  return subscribeToEvent<AgentSessionEvent>(
    (receive) =>
      events.agentSessionEvent.listen((event) => {
        receive(event.payload)
      }),
    (payload) => {
      if (payload.kind === kind) {
        handler(payload as Extract<AgentSessionEvent, { kind: TKind }>)
      }
    },
    onListenFailure,
  )
}
