import './command-output.css'

import { useCopy } from '@poietica/design-system'
import { CheckIcon, CloseIcon, CopyIcon } from '../../shared/primitives/icons'

/*
 * 最近一条斜杠命令的结果。它不进会话文件（omp 只把它交给宿主一次），所以不画进时间线：
 * 画进去的东西整页重取就没了，人会以为命令没跑。用 role=status：结果到达时读屏念一次，不抢焦点。
 *
 * 只有「需要另外告诉人」的结果才到这里：压缩、交接在时间线上有自己那一行，改名、换模型由标题与模型胶囊自己变，
 * 引擎不推它们（command-output.ts）。所以这里没有「跑着」那一态 —— 一出现就是结果。
 *
 * 一句话的结果（「当前模型：…」「已移除 3 个工具结果…」）一行说完；多行的才是一张卡，可复制。
 * 正文默认是正文字体，只有按列对齐的报表（/context 的用量条、/usage 的表）才换等宽 —— 等宽只为对齐，不是「命令行的样子」。
 */
export interface CommandOutputDockProps {
  readonly command: string
  readonly lines: readonly string[]
  readonly onDismiss: () => void
}

/** 按列排的报表：用量条、制表、两格以上的空白对齐、行首缩进 —— 换成比例字体就散了 */
export function looksTabular(text: string): boolean {
  return /[─│┌┐└┘├┤█░▓▒■□]/u.test(text) || /\S {2,}\S/.test(text) || /^ {2,}\S/m.test(text) || text.includes('\t')
}

/** 斜杠命令的名字（`/context`）；入口页铸号失败时没有命令可说 */
function nameOf(command: string): string {
  const name = command.split(/\s+/)[0] ?? ''
  return name === '' ? '命令' : name
}

function CloseButton({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <button aria-label="关闭" className="assistant-command-output__action" onClick={onDismiss} type="button">
      <CloseIcon aria-hidden="true" />
    </button>
  )
}

export function CommandOutputDock({ command, lines, onDismiss }: CommandOutputDockProps) {
  const { copied, copy } = useCopy()
  const text = lines.join('\n').trim()
  const name = nameOf(command)

  if (!text.includes('\n')) {
    return (
      <section aria-label={`${name} 的结果`} className="assistant-command-output" data-shape="line" role="status">
        <span className="assistant-command-output__name">{name}</span>
        <span className="assistant-command-output__line">{text}</span>
        <CloseButton onDismiss={onDismiss} />
      </section>
    )
  }

  return (
    <section aria-label={`${name} 的结果`} className="assistant-command-output" data-shape="block" role="status">
      <div className="assistant-command-output__head">
        <span className="assistant-command-output__name">{name}</span>
        <button
          aria-label={copied ? '已复制' : '复制结果'}
          className="assistant-command-output__action"
          data-copied={copied ? 'true' : undefined}
          onClick={() => copy(text)}
          type="button"
        >
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        </button>
        <CloseButton onDismiss={onDismiss} />
      </div>
      <div className="assistant-command-output__body" data-tabular={looksTabular(text) ? 'true' : undefined}>
        {text}
      </div>
    </section>
  )
}
