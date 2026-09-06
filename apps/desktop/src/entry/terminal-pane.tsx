import { terminalHostPort } from '@poietica/native-bridge/terminal'
import { TerminalPane } from '@poietica/terminal/surface'
/* Terminal teardown lives in the dock host, outside the Xterm chunk. */
import { useConversationWorkspaceRoot } from '../assistant/threads-context'

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
