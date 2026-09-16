import './composer-notice.css'

import { memo, useState } from 'react'
import { FailureIcon, ResetIcon } from '../primitives/icons'

/*
 * 输入区上沿的一条提示：连不上 agent 时的那一句。
 *
 * 长在卡外而不是工具栏里 —— 工具栏那一行说的是"这一句由谁答"，报错不住在那里。
 *
 * 只有一个动作：重试。没有叉 —— 收起它就等于收起重试入口。连上那一刻失败被清掉，
 * 这一条随之消失。图标转到这一趟落地为止，所以重试交回的是承诺，不是"已发出"。
 */

export interface ComposerNoticeProps {
  /** 说给人听的那一句。 */
  readonly message: string
  /** 原样的失败原因，只做整条的 title。 */
  readonly detail?: string | undefined
  /** 重试那颗按钮。缺席就整个不画 —— 没有重试可给，不摆一颗按不出东西的钮。 */
  readonly onRetry?: (() => void | Promise<void>) | undefined
}

export const ComposerNotice = memo(function ComposerNotice({
  detail,
  message,
  onRetry,
}: ComposerNoticeProps) {
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
