import type { Disposable } from '@poietica/foundation'
import { defineServiceToken } from '@poietica/foundation'
import type { TurnContextBlock } from '@poietica/runtime-protocol'

export interface TurnContextPart {
  readonly text: string
  delivered(): void
  undelivered?(): void
}

export interface TurnContextProvider {
  readonly id: string
  collect(threadId: string): TurnContextPart | null
}

export interface CollectedContext {
  readonly blocks: readonly TurnContextBlock[]
  delivered(): void
  undelivered(): void
}

export interface TurnContextRegistry {
  register(provider: TurnContextProvider): Disposable
  collect(threadId: string): CollectedContext
}

export const TurnContextRegistryToken = defineServiceToken<TurnContextRegistry>('runs', 'TurnContextRegistry')
