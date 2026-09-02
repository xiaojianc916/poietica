import { ReviewPane, type ReviewPaneProps } from '@poietica/auxiliary/review-ui'
import { reviewGateway } from '@poietica/native-bridge'
import { reportFailure } from '../notice/problem-presentation'
import { useConversationWorkspaceRoot } from './threads-context'

/*
 * 组合根的接线：从应用的会话上下文读出工作目录，把 git 网关与失败上报交进
 * @poietica/auxiliary/review-ui 那一份 ReviewPane。这里不裁决任何东西。
 */

/* 模块级事实：内联箭头每渲一个新身份，会把 ReviewPane 的 store 连环重建、闪回「正在读取变更」。 */
const report: ReviewPaneProps['report'] = (code, context) => {
  reportFailure(code, { ...context, scope: 'review' })
}

export function ConversationReviewPane({
  conversationId,
}: {
  readonly conversationId: string | null
}) {
  const root = useConversationWorkspaceRoot(conversationId)

  if (root === null) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">这条对话没有工作目录。</p>
  }

  return <ReviewPane gateway={reviewGateway} key={root} report={report} root={root} />
}
