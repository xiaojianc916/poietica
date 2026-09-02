import { TerminalPane } from '@poietica/auxiliary/terminal-ui'
import { terminalHostPort } from '@poietica/native-bridge'
/* Terminal teardown lives in the dock host, outside the Xterm chunk. */
import { useConversationWorkspaceRoot } from './threads-context'

/*
 * 组合根的接线：从会话上下文读出工作目录，把原生端口交进 @poietica/auxiliary 的
 * 那一份 TerminalPane。这里不裁决任何东西。
 */

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
