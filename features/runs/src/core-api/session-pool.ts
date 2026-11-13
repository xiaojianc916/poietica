import { type Clock, type Disposable, defineServiceToken, type Logger } from '@poietica/foundation'
import type { EngineSession, EngineSessionEvent, OpenSessionSpec, RuntimeServices } from '@poietica/runtime-protocol'

export interface SessionPoolDeps {
  readonly runtime: RuntimeServices['sessions']
  readonly clock: Clock
  readonly logger: Logger
  describe(threadId: string): OpenSessionSpec
  onOpened(threadId: string, session: EngineSession): void
  onEvent(threadId: string, event: EngineSessionEvent): void
  onReleased(threadId: string): void
}

export interface SessionPool extends Disposable {
  acquire(threadId: string): Promise<EngineSession>
  peek(threadId: string): EngineSession | undefined
  isOpening(threadId: string): boolean
  release(threadId: string): Promise<void>
  invalidate(): Promise<void>
}

export type CreateSessionPool = (deps: SessionPoolDeps) => SessionPool

export const SessionPoolFactoryToken = defineServiceToken<CreateSessionPool>('runs', 'SessionPoolFactory')
