import { type AgentProfile, agentById, agentRoster } from '@poietica/agent-catalog'
import { Select, type SelectOption } from '@poietica/ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentConfigSnapshot, AgentConfigStore } from '../agent-config-store'
import { describeAgentCliFailure } from '../agent-install/agent-cli-text'
import { AgentInstallAction } from '../agent-install/agent-install-action'
import { AgentModels } from './agent-models'
import './models-settings.css'

/*
 * 设置 · 模型的外壳。
 *
 * 它只管跨 agent 的那三件事：读 agents.json、选哪一家、把这个选择落盘。别的一切 ——
 * 模型清单、密钥尾号、待导入的全局配置、删除确认 —— 都只对某一家 agent 成立，住在
 * AgentModels 里，由这里以 key={agentId} 挂载。
 *
 * key 不是性能技巧，是这一页的作废规则：换一家 agent，那些状态全都不再成立，React 直接
 * 换一棵子树（官方文档 Preserving and Resetting State）。此前它们与这里挤在一个组件里，
 * 换 agent 只改一个字符串，于是上一家探出来的导入清单会留在屏幕上，点「确认导入」把它
 * 导进新选的那一家。
 *
 * 这一行也不需要「保存」这个动作：这一页显示的就是 agent 此刻的真实配置。
 */

/*
 * 可选的 ACP agent。
 *
 * 名单来自 @poietica/agent-registry，是封闭的 —— 用户在注册过的几家里选，不能自带一条
 * 命令。今天只注册了一家，所以下拉里只会有一项；接第二家时这里一个字都不用改。
 */
const AGENT_OPTIONS: readonly SelectOption[] = agentRoster().map((agent) => ({
  value: agent.id,
  label: agent.displayName,
}))

/** agents.json 那条写入失败时说什么。两个调用点共用一句。 */
const AGENT_ACTION_FAILED = 'agent 配置操作失败，请重试。'

export interface ModelsSettingsProps {
  readonly store: AgentConfigStore
}

export function ModelsSettings({ store }: ModelsSettingsProps) {
  /*
   * 首帧的占位，不是"默认那一家"。
   *
   * 真正的选择只有一个产地：agents.json 的 defaultAgentId，它由下面那次 store.load()
   * 读回来并覆盖这里。这一格存在的唯一理由是下拉在第一帧要有个 value —— 所以它取名单
   * 第一项就够了，而注册表也不再提供"默认"这个概念去让人误用。
   */
  const [agentId, setAgentId] = useState<string>(() => agentRoster()[0].id)
  const [profiles, setProfiles] = useState<readonly AgentProfile[]>([])
  const [agentError, setAgentError] = useState<string | null>(null)

  /*
   * 密钥该注入哪个环境变量名，写在档案里。
   *
   * 不写死在这里：换第二家 agent 时变量名不一样，而这一页对两家应该是同一段代码。缺席
   * 就是缺席 —— 卡片会说「这个 agent 没有声明」，而不是替它挑一个名字试试看。
   */
  const registryKeyVar = useMemo(() => agentById(agentId)?.registryKeyVar, [agentId])

  const applySnapshot = useCallback((snapshot: AgentConfigSnapshot) => {
    setProfiles(snapshot.agents)
    setAgentId(snapshot.defaultAgentId)
    setAgentError(snapshot.issues.length > 0 ? snapshot.issues.join('；') : null)
  }, [])

  /* 读一次落盘的配置。ignore 标志防的是两次往返先后颠倒，不是「卸载后 setState」。 */
  useEffect(() => {
    let active = true

    void store.load().then(
      (snapshot) => {
        if (active) {
          applySnapshot(snapshot)
        }
      },
      (cause: unknown) => {
        if (active) {
          setAgentError(describeAgentCliFailure(cause, AGENT_ACTION_FAILED))
        }
      },
    )

    return () => {
      active = false
    }
  }, [applySnapshot, store])

  /*
   * 选中即落盘。
   *
   * 先把界面切过去，失败再切回来：这一步只改 agents.json 的一个字段，成功是常态，让下拉
   * 干等一次往返只会显得迟钝。回滚用的是点击前的那个值，而不是「默认值」—— 否则一次失败
   * 会把用户先前的选择也一并抹掉。
   *
   * 档案一定不为空：store.load() 在磁盘为空时已经把内置档案写进 agents.json 了。真的读到
   * 空只可能是那次读取失败，而这时写一份空名单进去，原生侧连该起哪个程序都查不到 ——
   * 宁可什么都不做，并说出原因。
   */
  const selectAgent = useCallback(
    (nextId: string) => {
      const previousId = agentId

      if (profiles.length === 0) {
        setAgentError('还没有读到 agent 接入档案，请稍后重试。')
        return
      }

      setAgentId(nextId)
      setAgentError(null)

      void store.saveAgents({ agents: profiles, defaultAgentId: nextId }).then(
        (snapshot) => {
          applySnapshot(snapshot)

          /*
           * 换了 agent 是「agent 配置变了」里最大的一次。不喊这一声，主界面那半
           * 边就还在跟上一家说话 —— 方言、会话桥与对话端口都在这个通道上重新认领。
           */
          store.notifyConfigChanged()
        },
        (cause: unknown) => {
          setAgentId(previousId)
          setAgentError(describeAgentCliFailure(cause, AGENT_ACTION_FAILED))
        },
      )
    },
    [agentId, applySnapshot, profiles, store],
  )

  return (
    <section className="models-page">
      {/*
       * 这张卡与它上面的下拉都住在 key 的外面。
       *
       * 它们此前是作为 prop 传进 AgentModels 的，也就是渲染在 key={agentId} 控制的
       * 那棵子树里。于是：点一项 → selectAgent 先乐观地 setAgentId → key 变 → 下拉
       * 连同触发器一起被销毁重建，Base UI 的关闭过渡与「焦点还给触发器」都落在一个
       * 已经不存在的节点上，焦点掉回 body。落盘失败回滚时再拆一次，而每次挂载都会
       * 真去起一个子进程重读清单 —— 一次失败的切换要跑两趟。
       *
       * key 重置的是「随所选 agent 一起作废」的状态；做出这个选择的控件不在其中。
       */}
      <div className="models-block">
        <span className="models-block__label">智能体</span>

        <div className="models-card">
          <div className="models-row">
            <div className="models-row__copy">
              <strong>ACP Agent</strong>
              <p>{agentError ?? '选择用于对话的 agent，可用模型与密钥由它提供'}</p>
            </div>

            <div className="models-row__control">
              <AgentInstallAction agentId={agentId} store={store} />

              <Select
                className="models-select-trigger"
                data={AGENT_OPTIONS}
                onValueChange={selectAgent}
                type="ACP Agent"
                value={agentId}
              />
            </div>
          </div>
        </div>
      </div>

      <AgentModels agentId={agentId} key={agentId} registryKeyVar={registryKeyVar} store={store} />
    </section>
  )
}
