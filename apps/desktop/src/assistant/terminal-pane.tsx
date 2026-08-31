import { terminalHostPort } from '@poietica/native-bridge'
import { warn } from '@poietica/problem'
import { TerminalPane } from '@poietica/surfaces'
import { useConversationWorkspaceRoot } from './threads-context'

/*
 * 组合根的接线：从会话上下文读出工作目录，把原生端口交进 @poietica/surfaces 的
 * 那一份 TerminalPane。这里不裁决任何东西。
 */

/** 这一格被关掉时收尾。卸载只是换标签，关闭才是结束这条 shell。 */
export function releaseConversationTerminal(root: string | null): void {
  if (root === null) {
    return
  }

  void terminalHostPort.close(root).catch((cause: unknown) => {
    warn('终端会话没能关掉', { cause, scope: 'terminal' })
  })
}

export function ConversationTerminalPane({
  conversationId,
}: {
  readonly conversationId: string | null
}) {
  const root = useConversationWorkspaceRoot(conversationId)

  if (root === null) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">这条对话没有工作目录。</p>
  }

  return <TerminalPane key={root} port={terminalHostPort} root={root} />
}
