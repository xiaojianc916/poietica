import { Button, InlineSpinner } from '@poietica/design-system'
import type { AgentConfigStore } from '../agent-config-store'
import { useAgentInstall } from './use-agent-install'

export interface AgentInstallActionProps {
  readonly store: AgentConfigStore
  readonly agentId: string
}

/**
 * ACP Agent 这一行上的「安装 / 更新」。
 *
 * 真的无事可说时它一个像素都不画：一个装好、是最新、且刚才什么都没发生的 agent，这一
 * 行不该有噪音。但「无事可说」要由 hook 判定 —— 装完那句结果、装在别处那句说明，都是
 * 有事可说。
 *
 * 尺寸与形状取自设计系统的行内动作按钮（soft / xs），与这一页其余按钮同一颗。
 */
export function AgentInstallAction({ store, agentId }: AgentInstallActionProps) {
  const install = useAgentInstall(store, agentId)

  /* 失败压过处境：一次点击的结果比一句长期说明更要紧。 */
  const message = install.error ?? install.note

  if (install.action === 'none' && message === null) {
    return null
  }

  return (
    <>
      {message === null ? null : <span className="models-row__meta">{message}</span>}
      {install.busy ? <InlineSpinner /> : null}
      {install.action === 'none' ? null : (
        <Button
          disabled={install.busy}
          onClick={install.run}
          size="xs"
          type="button"
          variant="soft"
        >
          {install.label}
        </Button>
      )}
    </>
  )
}
