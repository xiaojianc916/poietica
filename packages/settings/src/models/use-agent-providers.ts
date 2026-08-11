import {
  type AgentProviderSnapshot,
  acpAgentById,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentConfigStore } from '../agent-config-store'
import { describeAgentCliFailure, describeAgentCliOutcome } from '../agent-install/agent-cli-text'

/*
 * 向 agent 问一次「你配了哪些 provider、哪些模型」。
 *
 * 产地只有一个：agent 官方 CLI 的 provider list --json。权威永远是 agent 的配置
 * 文件，这里不存第二份 —— 内存里这份缓存只是展示层的 stale-while-revalidate：
 * 重新进入这一页时先摆上一次的快照，后台这一次往返回来后再换。它随进程退出
 * 消失，从来不是「真相」，所以不需要失效逻辑 —— 每次挂载都会真问一次。
 *
 * 缓存按 agentId 分键：换 agent 时看到的是它自己的上一份，不是上一家 agent 的。
 *
 * 「当前选中哪个模型」不在这里。那个要问 ACP 会话的 configOptions：它是会话级
 * 的，而且只有活着的会话才知道。两件事分属两条管线，合并会让其中一条撒谎。
 */
const lastGood = new Map<string, AgentProviderSnapshot>()

export interface AgentProvidersState {
  readonly loading: boolean
  readonly snapshot: AgentProviderSnapshot | undefined
  /** 什么都拿不出来。列表的位置归它。 */
  readonly error: string | null
  /** 有东西可看，但这一次没读成。旧清单继续显示，由界面在旁边说清它是旧的。 */
  readonly refreshError: string | null
  readonly reload: () => void
}

export function useAgentProviders(store: AgentConfigStore, agentId: string): AgentProvidersState {
  const [loading, setLoading] = useState(() => !lastGood.has(agentId))
  const [snapshot, setSnapshot] = useState<AgentProviderSnapshot | undefined>(() =>
    lastGood.get(agentId),
  )
  const [error, setError] = useState<string | null>(null)

  /*
   * 「有东西可看，但这一次没读成」，与 error 分开。
   *
   * 界面对这两件事的处置不同：error 出现时列表是空的，它占据列表的位置；这一条
   * 出现时列表还在，它只挂在上方。stale-while-revalidate 保留旧数据的同时本来就
   * 要把失败暴露出去 —— 此前这里连失败一起吞了，于是删掉一个 provider、重读没成，
   * 那一行还在屏幕上，界面一个字都不说。
   */
  const [refreshError, setRefreshError] = useState<string | null>(null)

  /*
   * 每次询问领一个号，只有最新的号有权写状态。卸载时递增一次，在飞的那次自然作废。
   */
  const generation = useRef(0)

  const ask = useCallback(() => {
    generation.current += 1

    const mine = generation.current
    const stale = () => mine !== generation.current

    /*
     * 问什么、以及哪个 id 是环境变量合成的保留条目，都写在 agent 的档案里。
     * 这一层不认识任何一家 —— 与 provider-state 里那句是同一个理由。
     */
    const descriptor = acpAgentById(agentId)

    if (descriptor === undefined) {
      setLoading(false)
      setSnapshot(undefined)
      setError(`没有登记 ${agentId} 这个 agent 的接入档案。`)

      return
    }

    /*
     * 这一家有没有这种查询，档案说了算 —— 契约里 providerListArgs 是可选的，
     * 缺席就是「问不了」，不是「随便发一条命令试试」。
     */
    const listArgs = descriptor.providerListArgs

    if (listArgs === undefined) {
      setLoading(false)
      setSnapshot(undefined)
      setError(`${descriptor.displayName} 没有声明查询模型清单的子命令。`)

      return
    }

    /*
     * 有缓存先摆缓存，后台再真问 —— 重新进入不再每次空等一次进程启动。
     * 没有缓存才进 loading：那是唯一一次「什么都还拿不出来」的等待。
     */
    const cached = lastGood.get(agentId)

    if (cached !== undefined) {
      setSnapshot(cached)
    } else {
      setSnapshot(undefined)
      setLoading(true)
    }

    setError(null)
    setRefreshError(null)

    void store
      .execCli({
        agentId,
        args: [...listArgs],
      })
      .then(
        (outcome) => {
          /*
           * 非零退出时把 agent 自己的 stderr 直接给用户看。config.toml 坏了的
           * 时候它说得比我们清楚 —— 连怎么修都告诉你 —— 转述一遍只会丢信息。
           *
           * 有缓存时不换掉列表：上一快照仍是 agent 片刻前的真实配置。但这次没读成
           * 要说出来 —— 保存密钥、删除密钥、按刷新，三条路都靠这一次往返给回音。
           */
          if (outcome.status !== 0) {
            if (stale()) {
              return
            }

            setLoading(false)

            const reason = describeAgentCliOutcome(outcome)

            if (cached === undefined) {
              setSnapshot(undefined)
              setError(reason)
            } else {
              setRefreshError(reason)
            }

            return
          }

          const next = parseAgentProviderListOutput(outcome.stdout, descriptor.syntheticProviderId)

          /*
           * 缓存写在作废判断之前。号过期只意味着这份回执无权改屏幕，不意味着数据
           * 是假的 —— 它是 agent 刚说的。写缓存与订阅是两件事，绑在一起会让一次
           * 已经付过进程启动代价的往返白跑。
           */
          lastGood.set(agentId, next)

          if (stale()) {
            return
          }

          setLoading(false)
          setRefreshError(null)
          setSnapshot(next)
        },
        (cause: unknown) => {
          if (stale()) {
            return
          }

          setLoading(false)

          const reason = describeAgentCliFailure(cause, '无法读取模型清单。')

          if (cached === undefined) {
            setSnapshot(undefined)
            setError(reason)
          } else {
            setRefreshError(reason)
          }
        },
      )
  }, [agentId, store])

  useEffect(() => {
    ask()

    return () => {
      generation.current += 1
    }
  }, [ask])

  return { loading, snapshot, error, refreshError, reload: ask }
}
