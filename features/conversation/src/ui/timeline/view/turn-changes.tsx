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
  /**
   * 点某一行文件：把它的改动开到右坞。
   *
   * 缺席时文件行画成纯文本（不画一个点了没反应的按钮）—— 没装 files 功能的宿主就是这一档。
   */
  readonly onOpenDiff?: ((path: string) => void) | undefined
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

/** 路径的最后一段（文件名）：显示时它用主墨，前面的目录退一档。 */
export function fileNameOf(path: string): string {
  const cut = path.lastIndexOf('/')

  return cut === -1 ? path : path.slice(cut + 1)
}

/** 文件名之前那段目录；根目录下的文件没有这一段，不画空的一格。 */
export function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/')

  return cut === -1 ? '' : path.slice(0, cut)
}

export function TurnChangesBar({ busy = false, expanded, onOpenDiff, onRewind, onToggle, view }: TurnChangesBarProps) {
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
          {view.files.map((file) => {
            /*
              文件名与目录分层，照 zcode 的 FileDisplayInline：叶子用主墨、所在目录用次要墨。
              整条路径一样深在读的时候就得逐字找文件名，一层目录几十个文件时尤其明显。
            */
            const label = (
              <>
                <span className="turn-changes__path" title={file.path}>
                  <span className="turn-changes__name">{fileNameOf(file.path)}</span>
                  {directoryOf(file.path) === '' ? null : (
                    <span className="turn-changes__dir">{directoryOf(file.path)}</span>
                  )}
                </span>
                <span className="turn-changes__stat">
                  {file.added > 0 ? <span className="turn-changes__added">{addedLabel(file.added)}</span> : null}
                  {file.removed > 0 ? (
                    <span className="turn-changes__removed">{removedLabel(file.removed)}</span>
                  ) : null}
                </span>
              </>
            )

            /* 有人认领「开 diff」才做成按钮：否则画成一行纯文本，不留一个点了没反应的东西。 */
            return onOpenDiff === undefined ? (
              <li className="turn-changes__file" key={file.path}>
                {label}
              </li>
            ) : (
              <li key={file.path}>
                <button
                  className="turn-changes__file turn-changes__file--open"
                  onClick={() => {
                    onOpenDiff(file.path)
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  title={`在右坞打开 ${file.path} 的改动`}
                  type="button"
                >
                  {label}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
