import type { TurnContextBlock } from '@poietica/engine'
import { type Disposable, invariant, type Logger, toDisposable } from '@poietica/foundation'
import type { TurnContextProvider, TurnContextRegistry } from '../core-api'

/** 一块上下文的上限（字符数）：提供方写坏了也撑不爆一轮。超了整块不带，记一条 warn */
export const TURN_CONTEXT_MAX = 16_384

export interface CollectedContext {
  readonly blocks: readonly TurnContextBlock[]
  /** 这一句确实交给了引擎：逐个回调提供方 */
  delivered(): void
}

const NOTHING: CollectedContext = { blocks: [], delivered: () => undefined }

/**
 * `TurnContextRegistry` 的实现，归 conversation 所有（提交服务在交接时调 `collect`）。
 * 提供方按 id 排序问，交出去的顺序稳定；某一家抛错只记日志、不带它那块，这一句照常送达。
 */
export class TurnContextHub implements TurnContextRegistry {
  private readonly providers = new Map<string, TurnContextProvider>()

  constructor(private readonly logger: Logger) {}

  register(provider: TurnContextProvider): Disposable {
    invariant(!this.providers.has(provider.id), `轮次上下文提供方重复登记：${provider.id}`)
    this.providers.set(provider.id, provider)
    return toDisposable(() => {
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id)
    })
  }

  collect(threadId: string): CollectedContext {
    if (this.providers.size === 0) return NOTHING
    const blocks: TurnContextBlock[] = []
    const acks: (() => void)[] = []
    for (const id of [...this.providers.keys()].sort()) {
      const part = this.ask(id, threadId)
      if (part === null) continue
      blocks.push({ source: id, text: part.text })
      acks.push(part.delivered)
    }
    if (blocks.length === 0) return NOTHING
    return {
      blocks,
      delivered: () => {
        for (const ack of acks) this.safely(() => ack(), 'turn context ack failed')
      },
    }
  }

  private ask(id: string, threadId: string): { readonly text: string; readonly delivered: () => void } | null {
    const provider = this.providers.get(id)
    if (provider === undefined) return null
    let part: ReturnType<TurnContextProvider['collect']> = null
    this.safely(() => {
      part = provider.collect(threadId)
    }, `turn context provider failed: ${id}`)
    const found = part as ReturnType<TurnContextProvider['collect']>
    if (found === null || found.text.trim() === '') return null
    if (found.text.length > TURN_CONTEXT_MAX) {
      this.logger.warn('turn context too large, skipped', { provider: id, size: found.text.length })
      return null
    }
    return found
  }

  private safely(work: () => void, message: string): void {
    try {
      work()
    } catch (error) {
      this.logger.warn(message, { error: String(error) })
    }
  }
}
