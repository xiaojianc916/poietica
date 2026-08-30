import { reviewGateway } from '@poietica/native-bridge'
import { ReviewPane } from '@poietica/review-ui'
import { reportFailure } from '../notice/application-policy'
import { useConversationWorkspaceRoot } from './threads-context'

/*
 * 组合根的接线：从应用的会话上下文读出工作目录，把 git 网关与失败上报交进
 * @poietica/review-ui 那一份 ReviewPane。这里不裁决任何东西。
 */

export function ConversationReviewPane({
  conversationId,
}: {
  readonly conversationId: string | null
}) {
  const root = useConversationWorkspaceRoot(conversationId)

  if (root === null) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">这条对话没有工作目录。</p>
  }

  return (
    <ReviewPane
      gateway={reviewGateway}
      key={root}
      report={(code, context) => {
        reportFailure(code, { ...context, scope: 'review' })
      }}
      root={root}
    />
  )
}
