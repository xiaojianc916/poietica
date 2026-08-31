import {
  type AgentProviderSnapshot,
  agent,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'
import type { AgentConfigStore } from '@poietica/settings'
import { useCallback, useEffect, useRef, useState } from 'react'
import { describeAgentCliFailure, describeAgentCliOutcome } from '../agent-install/agent-cli-text'

/*
 * 向 agent 问一次「你配了哪些 provider、哪些模型」。
 *
 * 产地只有一个：agent 官方 CLI 的 provider list --json。权威永远是 agent 的配置
 * 文件，这里不存第二份 —— 内存里这份缓存只是展示层的 stale-while-revalidate：
 * 重新进入这一页时先摆上一次的快照，后台这一次往返回来后再换。它随进程退出
 * 消失，从来不是「真相」，所以不需要失效逻辑 —— 每次挂载都会真问一次。
 *
 * 「当前选中哪个模型」不在这里。那个要问 ACP 会话的 configOptions：它是会话级
 * 的，而且只有活着的会话才知道。两件事分属两条管线，合并会让其中一条撒谎。
 */
let lastGood: AgentProviderSnapshot | undefined

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
  const [loading, setLoading] = useState(() => lastGood === undefined)
  const [snapshot, setSnapshot] = useState<AgentProviderSnapshot | undefined>(() => lastGood)
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
     * 有缓存先摆缓存，后台再真问 —— 重新进入不再每次空等一次进程启动。
     * 没有缓存才进 loading：那是唯一一次「什么都还拿不出来」的等待。
     */
    const cached = lastGood

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
        args: [...agent.providerListArgs],
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

          const next = parseAgentProviderListOutput(outcome.stdout, agent.syntheticProviderId)

          /*
           * 缓存写在作废判断之前。号过期只意味着这份回执无权改屏幕，不意味着数据
           * 是假的 —— 它是 agent 刚说的。写缓存与订阅是两件事，绑在一起会让一次
           * 已经付过进程启动代价的往返白跑。
           */
          lastGood = next

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
