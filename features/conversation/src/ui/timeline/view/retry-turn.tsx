import { ResetIcon } from '../../shared/primitives/icons'

import './retry-turn.css'

/**
 * 末轮以报错收尾时，时间线尾部那一颗「重试」：它就是 omp 的 `/retry`（AgentSession.retry —— 撤掉失败的那条回复再续一轮），
 * 不是本仓把上一句话重新提交一遍。能不能重试由 omp 判断，判不了它会在命令输出里说「Nothing to retry.」。
 */
export function RetryTurn({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="timeline-retry">
      <button className="timeline-retry__action" onClick={onRetry} title="重试失败的这一轮（/retry）" type="button">
        <ResetIcon aria-hidden="true" className="timeline-retry__mark" />
        <span>重试这一轮</span>
      </button>
    </div>
  )
}
