import { Undo2 } from 'lucide-react'
import type { TurnChangesView } from '../../../ui-api'
import { ChevronDownIcon } from '../../shared/primitives/icons'
import './turn-changes.css'

/*
 * 一轮回复下面那条「N 个文件已更改 +A -D / 撤销」。
 *
 * 纯展示：给什么画什么，不认识 review、不认识 RPC。展开只列文件，不铺 inline diff ——
 * 这一条的位置在回复末尾，摊开一整份补丁会把下一轮推走好几屏。
 */

export interface TurnChangesBarProps {
  readonly view: TurnChangesView
  /** 点「撤销」：确认、回退、置灰都由外面办，这一层只管把这一下交出去。 */
  readonly onRewind: () => void
  /** 有一次撤销还在路上：键画成不可用，防止连点两次写两遍工作区。 */
  readonly busy?: boolean
  readonly expanded: boolean
  readonly onToggle: () => void
}

/** 「3 个文件已更改」。数量是提供方数好的，这一格只补量词。 */
export function fileCountLabel(count: number): string {
  return `${String(count)} 个文件已更改`
}

/** 数字带符号：光有「12」读不出是加还是删；0 也照画，那一侧的 0 是事实。 */
export function addedLabel(added: number): string {
  return `+${String(added)}`
}

export function removedLabel(removed: number): string {
  return `-${String(removed)}`
}

export function TurnChangesBar({ busy = false, expanded, onRewind, onToggle, view }: TurnChangesBarProps) {
  const reverted = view.reverted
  return (
    <div className="turn-changes" data-reverted={reverted ? 'true' : undefined}>
      <div className="turn-changes__head">
        <button
          aria-expanded={expanded}
          className="turn-changes__toggle"
          onClick={onToggle}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          <ChevronDownIcon aria-hidden="true" className="turn-changes__chevron" />
          <span className="turn-changes__summary">{fileCountLabel(view.fileCount)}</span>
          <span className="turn-changes__stat">
            <span className="turn-changes__added">{addedLabel(view.added)}</span>
            <span className="turn-changes__removed">{removedLabel(view.removed)}</span>
          </span>
        </button>

        {/*
          撤销过之后键还在，只是禁用、文案换成「已撤销」：换成一段纯文字会让这一行的右侧在
          点下去那一刻换宽度与对齐 —— 而这张卡恰好在动作刚发生的那一刻被看见。是否办过由
          文案说，能不能点由 disabled 说，两件事分开。
        */}
        <button
          aria-label={reverted ? '这一轮的改动已撤销' : `撤销这一轮的 ${String(view.fileCount)} 个文件改动`}
          className="turn-changes__rewind"
          disabled={reverted || busy}
          onClick={onRewind}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          <Undo2 aria-hidden="true" className="turn-changes__rewind-icon" />
          {reverted ? '已撤销' : '撤销'}
        </button>
      </div>

      {expanded ? (
        <ul className="turn-changes__files">
          {view.files.map((file) => (
            /* TODO: 点文件行在右坞开这一行的 diff（要 files/review 的右坞贡献点，这一档先不做）。 */
            <li className="turn-changes__file" key={file.path}>
              <span className="turn-changes__path" title={file.path}>
                {file.path}
              </span>
              <span className="turn-changes__stat">
                <span className="turn-changes__added">{addedLabel(file.added)}</span>
                <span className="turn-changes__removed">{removedLabel(file.removed)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
