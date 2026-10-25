import type { Logger } from '@poietica/foundation'
import type { TurnRewind } from './rewind'

/**
 * 把 conversation 的 turnFileChanged 转成账本里的一行。
 *
 * 事件只带 threadId —— 工作区路径要从线程上问（ConversationServiceToken 的 get 给出 workspaceId，
 * WorkspacesServiceToken 给出路径）。这一层就是那次翻译，单独拿出来是为了能用一个假 conversation
 * 服务钉住「线程已删就丢弃、不抛」这条规矩。
 */
export interface TurnFileFact {
  readonly threadId: string
  readonly turn: number
  readonly path: string
  readonly before: string | null
  readonly after: string | null
}

export interface TurnFileLedgerDeps {
  readonly rewind: TurnRewind
  /** 线程当前所在的工作区 id；线程已被删时 null。 */
  readonly workspaceIdOf: (threadId: string) => string | null
  /** 工作区目录（不存在时调用方抛 workspaces.directory_missing）。 */
  readonly pathOf: (workspaceId: string) => string
  readonly logger: Logger
}

export interface TurnFileLedger {
  record(fact: TurnFileFact): void
}

export function createTurnFileLedger(d: TurnFileLedgerDeps): TurnFileLedger {
  return {
    record(fact) {
      /*
       * 线程已经没了（用户在这条工具调用的同时删了对话）：这笔账没有主人，落下去就是一行永远
       * 没人看、也没人能撤的孤账。事件本身是有损的，丢这一条不影响任何已经在屏幕上的东西。
       */
      const workspaceId = d.workspaceIdOf(fact.threadId)
      if (workspaceId === null) {
        d.logger.warn('turn file change for a removed thread', { threadId: fact.threadId, path: fact.path })
        return
      }
      let workspaceRoot: string
      try {
        workspaceRoot = d.pathOf(workspaceId)
      } catch (e) {
        /* 工作区目录被移走 / 删掉：同样没有能撤销的落点。 */
        d.logger.warn('turn file change for an unusable workspace', {
          threadId: fact.threadId,
          workspaceId,
          error: String(e),
        })
        return
      }
      d.rewind.record({ ...fact, workspaceRoot })
    },
  }
}
