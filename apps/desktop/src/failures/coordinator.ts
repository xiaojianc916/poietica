/*
 * 一次失败的唯一去处。
 *
 * 严重级别是 impact 上的一格（见 @poietica/problem 的 failure-kernel），不是两条
 * 管线：终止与非终止共用同一份快照、同一次去重、同一条诊断记录。这就是这个
 * 子系统只有一个目录的原因 —— 按严重级别切目录，切开的是同一台状态机。
 */
import {
  type ClassifiedFailure,
  type ClassifiedFailureInput,
  createClassifiedFailure,
  createFailureScopeKey,
  isTerminalFailureImpact,
  type NonTerminalFailureImpact,
  optionalProperty,
  error as reportDiagnosticError,
  type TerminalFailureImpact,
} from '@poietica/problem'
import {
  createFailureDiagnostic,
  type FailureDiagnostic,
  type FailureDiagnosticHint,
  normalizeFailureCause,
  sanitizeFailureContext,
} from './diagnostic'

export interface FailureIncident extends ClassifiedFailure {
  readonly diagnostic: FailureDiagnostic
}

export type TerminalFailureIncident = FailureIncident & {
  readonly impact: TerminalFailureImpact
}

export type NonTerminalFailureIncident = FailureIncident & {
  readonly impact: NonTerminalFailureImpact
}

export interface PresentedFailure {
  readonly incident: NonTerminalFailureIncident
}

export interface TerminalFailureState {
  readonly incident: TerminalFailureIncident

  readonly additionalIncidentCount: number
}

export interface FailureSnapshot {
  readonly terminal: TerminalFailureState | null

  readonly operations: readonly PresentedFailure[]

  readonly degradedFeatures: ReadonlyMap<string, PresentedFailure>
}

export interface FailureSignal extends Omit<ClassifiedFailureInput, 'technicalMessage'> {
  readonly technicalMessage?: string

  readonly diagnostic?: FailureDiagnosticHint
}

export type FailureListener = () => void

const EMPTY_SNAPSHOT: FailureSnapshot = Object.freeze({
  terminal: null,

  operations: Object.freeze([]),

  degradedFeatures: new Map(),
})

const MAX_OPERATION_FAILURES = 20

export class FailureCoordinator {
  private snapshot: FailureSnapshot = EMPTY_SNAPSHOT

  private readonly listeners = new Set<FailureListener>()

  private readonly operations: PresentedFailure[] = []

  private readonly degradedFeatures = new Map<string, PresentedFailure>()

  private readonly terminalFingerprints = new Set<string>()

  readonly getSnapshot = (): FailureSnapshot => {
    return this.snapshot
  }

  readonly subscribe = (listener: FailureListener): (() => void) => {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  report(signal: FailureSignal): FailureIncident {
    const incident = this.createIncident(signal)

    this.recordDiagnostic(incident)

    if (isTerminalFailureImpact(incident.impact)) {
      return this.reportTerminal(incident as TerminalFailureIncident)
    }

    return this.reportNonTerminal(incident as NonTerminalFailureIncident)
  }

  /* 销号只对一次操作的失败成立：降级的功能由控件变灰说话，没有通知可关。 */
  dismiss(incidentId: string): void {
    const operationIndex = this.operations.findIndex((entry) => entry.incident.id === incidentId)
    if (operationIndex < 0) {
      return
    }
    this.operations.splice(operationIndex, 1)
    this.publish()
  }

  resolveOperation(operation: string): void {
    for (let index = this.operations.length - 1; index >= 0; index -= 1) {
      const entry = this.operations[index]
      const scope = entry?.incident.scope

      if (scope?.kind === 'operation' && scope.operation === operation) {
        this.operations.splice(index, 1)
      }
    }

    this.publish()
  }

  private createIncident(signal: FailureSignal): FailureIncident {
    const normalized = normalizeFailureCause(signal.cause)

    const technicalMessage = signal.technicalMessage ?? normalized.message

    const context = sanitizeFailureContext(signal.context)

    const classified = createClassifiedFailure({
      impact: signal.impact,
      code: signal.code,

      userMessage: signal.userMessage,

      technicalMessage,
      scope: signal.scope,
      recovery: signal.recovery,

      ...optionalProperty('cause', signal.cause),

      context,
    })

    return Object.freeze({
      ...classified,

      diagnostic: createFailureDiagnostic(signal.cause, signal.diagnostic),
    })
  }

  private reportTerminal(incident: TerminalFailureIncident): TerminalFailureIncident {
    const current = this.snapshot.terminal

    if (this.terminalFingerprints.has(incident.fingerprint)) {
      return current?.incident ?? incident
    }

    this.terminalFingerprints.add(incident.fingerprint)

    if (current) {
      this.snapshot = Object.freeze({
        ...this.snapshot,

        terminal: Object.freeze({
          incident: current.incident,

          additionalIncidentCount: current.additionalIncidentCount + 1,
        }),
      })

      this.emit()
      return current.incident
    }

    this.snapshot = Object.freeze({
      ...this.snapshot,

      terminal: Object.freeze({
        incident,
        additionalIncidentCount: 0,
      }),
    })

    this.emit()
    return incident
  }

  private reportNonTerminal(incident: NonTerminalFailureIncident): NonTerminalFailureIncident {
    switch (incident.impact) {
      case 'recoverable':
        this.recordOperation(incident)

        break

      case 'feature-degraded':
        if (incident.scope.kind !== 'feature') {
          throw new Error('Feature failure requires feature scope.')
        }

        this.recordScoped(this.degradedFeatures, incident.scope.featureId, incident)

        break
    }

    this.publish()
    return incident
  }

  private recordOperation(incident: NonTerminalFailureIncident): void {
    const existingIndex = this.operations.findIndex(
      (entry) => entry.incident.fingerprint === incident.fingerprint,
    )

    if (existingIndex >= 0) {
      this.operations.splice(existingIndex, 1)
    }

    this.operations.push(Object.freeze({ incident }))

    if (this.operations.length > MAX_OPERATION_FAILURES) {
      this.operations.splice(0, this.operations.length - MAX_OPERATION_FAILURES)
    }
  }

  private recordScoped(
    target: Map<string, PresentedFailure>,
    key: string,
    incident: NonTerminalFailureIncident,
  ): void {
    target.set(key, Object.freeze({ incident }))
  }

  private publish(): void {
    this.snapshot = Object.freeze({
      terminal: this.snapshot.terminal,

      operations: Object.freeze([...this.operations]),

      degradedFeatures: new Map(this.degradedFeatures),
    })

    this.emit()
  }

  private recordDiagnostic(incident: FailureIncident): void {
    try {
      reportDiagnosticError(incident.technicalMessage, {
        ...incident.context,

        failureId: incident.id,

        failureCode: incident.code,

        failureImpact: incident.impact,

        failureRecovery: incident.recovery,

        failureScope: createFailureScopeKey(incident.scope),
      })
    } catch (error: unknown) {
      try {
        console.error('[Poietica] Failure diagnostic reporting failed', error)
      } catch {
        // No further safe fallback.
      }
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error: unknown) {
        try {
          console.error('[Poietica] Failure coordinator listener failed', error)
        } catch {
          // No further safe fallback.
        }
      }
    }
  }
}

export const failureCoordinator = new FailureCoordinator()
