import './composer-notice.css'

import { memo, useState } from 'react'
import { FailureIcon, ResetIcon } from '../primitives/icons'

/* 连不上 agent 时输入区上沿那条提示：长在卡外而不是工具栏里（报错不住在"这一句由谁答"那一行）。
   没有叉 —— 收起它就等于收起重试入口；图标转到这一趟落地为止，重试交回的是承诺，不是"已发出"。 */

export interface ComposerNoticeProps {
  readonly message: string
  /** 原样的失败原因，只做整条的 title。 */
  readonly detail?: string | undefined
  /** 缺席就整个不画：没有重试可给，不摆一颗按不出东西的钮。 */
  readonly onRetry?: (() => void | Promise<void>) | undefined
}

export const ComposerNotice = memo(function ComposerNotice({ detail, message, onRetry }: ComposerNoticeProps) {
  const [retrying, setRetrying] = useState(false)
  const label = retrying ? '正在重新连接' : '重新连一次'

  return (
    <div className="assistant-notice" role="alert" title={detail}>
      <FailureIcon aria-hidden className="assistant-notice__mark" />

      <span className="assistant-notice__text">{message}</span>

      {onRetry === undefined ? null : (
        <button
          aria-label={label}
          className="assistant-notice__retry"
          data-retrying={retrying ? 'true' : undefined}
          disabled={retrying}
          onClick={() => {
            setRetrying(true)
            void Promise.resolve(onRetry()).finally(() => {
              setRetrying(false)
            })
          }}
          title={label}
          type="button"
        >
          <ResetIcon aria-hidden size={14} />
        </button>
      )}
    </div>
  )
})
