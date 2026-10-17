import './command-output.css'

import { CloseIcon, SpinnerIcon, TerminalIcon } from '../../shared/primitives/icons'

/*
 * 最近一条斜杠命令的输出。它不进会话文件（omp 只把它交给宿主一次），所以不画进时间线：
 * 画进去的东西整页重取就没了，人会以为命令没跑。用 role=status：输出到达时读屏念一次，不抢焦点。
 */
export interface CommandOutputDockProps {
  readonly command: string
  readonly lines: readonly string[]
  readonly onDismiss: () => void
}

export function CommandOutputDock({ command, lines, onDismiss }: CommandOutputDockProps) {
  const waiting = lines.length === 0
  return (
    <section aria-label="命令输出" className="assistant-command-output" role="status">
      <div className="assistant-command-output__head">
        {waiting ? <SpinnerIcon aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />}
        <span className="assistant-command-output__title">{command === '' ? '命令输出' : command}</span>
        <button aria-label="关闭命令输出" className="assistant-command-output__close" onClick={onDismiss} type="button">
          <CloseIcon aria-hidden="true" />
        </button>
      </div>
      {waiting ? null : <pre className="assistant-command-output__body">{lines.join('\n')}</pre>}
    </section>
  )
}
