import { agent } from '@poietica/agent-catalog'
import type { AgentConfigStore } from '@poietica/settings'
import { useEffect, useState } from 'react'
import { describeAgentCliFailure } from '../agent-install/agent-cli-text'
import { AgentInstallAction } from '../agent-install/agent-install-action'
import { AgentModels } from './agent-models'
import './models-settings.css'

/*
 * 设置 · 模型的外壳。
 *
 * 这台软件只接一家 agent，所以这一页没有「选哪一家」这个动作：上面那张卡说的是它装好
 * 了没有，下面整页是它的模型与密钥。也不需要「保存」—— 显示的就是 agent 此刻的真实配置。
 */

export interface ModelsSettingsProps {
  readonly store: AgentConfigStore
}

export function ModelsSettings({ store }: ModelsSettingsProps) {
  const [agentError, setAgentError] = useState<string | null>(null)

  /*
   * 读一次落盘的配置。这一趟唯一的产出是「配置里有什么没能用上」：档案本身由 store
   * 在这次读取里物化，界面不持有它的副本。
   *
   * active 标志防的是两次往返先后颠倒，不是「卸载后 setState」。
   */
  useEffect(() => {
    let active = true

    void store.load().then(
      (snapshot) => {
        if (active) {
          setAgentError(snapshot.issues.length > 0 ? snapshot.issues.join('；') : null)
        }
      },
      (cause: unknown) => {
        if (active) {
          setAgentError(describeAgentCliFailure(cause, 'agent 配置读取失败，请重试。'))
        }
      },
    )

    return () => {
      active = false
    }
  }, [store])

  return (
    <section className="models-page">
      <div className="models-block">
        <span className="models-block__label">智能体</span>

        <div className="models-card">
          <div className="models-row">
            <div className="models-row__copy">
              <strong>{agent.displayName}</strong>
              <p>{agentError ?? '本软件的对话由它提供，可用模型与密钥都归它'}</p>
            </div>

            <div className="models-row__control">
              <AgentInstallAction agentId={agent.id} store={store} />
            </div>
          </div>
        </div>
      </div>

      <AgentModels agentId={agent.id} registryKeyVar={agent.registryKeyVar} store={store} />
    </section>
  )
}
