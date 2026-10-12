import './thread-title-menu.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { useContributions } from '@poietica/ui-kernel'
import { ChevronDown, Download, Laptop, Pencil, Pin, PinOff } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import type { Thread } from '../../../contract'
import { threadActions } from '../../../ui-api'

/*
 * 会话页左上角的那一格：机器图标 + 这条对话的标题 + 下拉箭头。
 *
 * 标题**不缓存**：它整格从 `thread` prop 读，而调用方订阅着线程库 —— omp 总结出新标题
 * （`threads.updated` → stores.threads.upsert）时这里跟着换，用户改的名字同理。
 *
 * 三个部分各有各的语义（产品负责人 2026-10-12 定稿）：最左边的机器图标只是标记，
 * 悬停不给任何反馈；标题本身就是「改名」的入口，点一下换成就地输入框；下拉箭头才开菜单。
 * 标题上不再挂原生 title 提示 —— 它的悬停气泡与「点标题改名」是两回事，会互相打架。
 *
 * 菜单项与侧栏行菜单同一份次序、同一张脸（固定 / 重命名 / 导出会话，之后是其它功能
 * 贡献的动作，例如「以此对话创建定时任务」）；动作由上层交进来，这一格只画。
 */

export interface ThreadTitleMenuProps {
  /** 线程行还没到时整格不画（点开对话的头一帧）。 */
  readonly thread: Thread | undefined
  readonly onPin?: ((threadId: string, pinned: boolean) => void) | undefined
  readonly onRename?: ((threadId: string, title: string) => void) | undefined
  readonly onExport?: ((threadId: string) => void) | undefined
}

/* 就地改名的那一格：Enter / 失焦提交，Escape 放弃。 */
function TitleRenameField({
  initial,
  onCancel,
  onCommit,
}: {
  readonly initial: string
  readonly onCancel: () => void
  readonly onCommit: (title: string) => void
}): ReactNode {
  const [draft, setDraft] = useState(initial)
  const settled = useRef(false)

  /*
   * 挂载时取焦点并选中一次；ref 用 useCallback 钉住标识，不然每敲一个字都会重新全选。
   * 显式 focus 是必需的：从菜单点「重命名」进来时，焦点还在被卸载的弹层上，不抢回来的话
   * 输入框拿到焦点之前就可能吃到一次 blur，编辑框当场收掉（真机上表现为「点了没反应」）。
   */
  const selectOnMount = useCallback((node: HTMLInputElement | null) => {
    if (node !== null) {
      node.focus()
      node.select()
    }
  }, [])

  const finish = (outcome: 'cancel' | 'commit'): void => {
    if (settled.current) {
      return
    }
    settled.current = true
    if (outcome === 'commit') {
      onCommit(draft)
    } else {
      onCancel()
    }
  }

  return (
    <form
      className="conversation-title__rename"
      onSubmit={(event) => {
        event.preventDefault()
        finish('commit')
      }}
    >
      <input
        aria-label="重命名对话"
        className="conversation-title__field"
        onBlur={() => {
          finish('commit')
        }}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            finish('cancel')
          }
        }}
        ref={selectOnMount}
        value={draft}
      />
    </form>
  )
}

/*
 * 标题本身：点一下进就地改名。给不出改名动作时它只是文字，不装成按钮。
 *
 * 文字包一层 span：省略号只认**块级盒**里的行盒，落在按钮（flex 容器）上不生效 ——
 * 超长标题会被硬裁断，不是「…」截断（真机实测）。所以省略号写在里面那一层上。
 */
function TitleLabel({
  onRename,
  title,
}: {
  readonly onRename: (() => void) | undefined
  readonly title: string
}): ReactNode {
  const text = <span className="conversation-title__text">{title}</span>

  if (onRename === undefined) {
    return <span className="conversation-title__label conversation-title__label--static">{text}</span>
  }

  return (
    <button className="conversation-title__label" onClick={onRename} type="button">
      {text}
    </button>
  )
}

/* 下拉箭头与它那张菜单。菜单项次序与侧栏行菜单同一份；给不出的动作一律不画。 */
function ThreadActionsMenu({
  canRename,
  onBeginRename,
  onExport,
  onPin,
  thread,
}: {
  readonly canRename: boolean
  readonly onBeginRename: (() => void) | undefined
  readonly onExport: ((threadId: string) => void) | undefined
  readonly onPin: ((threadId: string, pinned: boolean) => void) | undefined
  readonly thread: Thread
}): ReactNode {
  /*
   * 菜单里点「重命名」不在当帧进编辑：弹层还在播关闭动画，Base UI 会把焦点还给触发器
   * （那时触发器正被编辑框换掉），两边抢焦点，编辑框一闪就没。等关闭动画彻底走完
   * （onOpenChangeComplete(false)）再进编辑，顺序就只剩一种。
   */
  const [wantsRename, setWantsRename] = useState(false)
  const contributions = useContributions(threadActions)
  const contributed = contributions.filter(
    (candidate) => candidate.item.visible === undefined || candidate.item.visible(thread),
  )
  const isPinned = thread.pinned
  const PinGlyph = isPinned ? PinOff : Pin

  return (
    <DropdownMenu
      onOpenChangeComplete={(open) => {
        if (!open && wantsRename) {
          setWantsRename(false)
          onBeginRename?.()
        }
      }}
    >
      <DropdownMenuTrigger aria-label="对话操作" className="conversation-title__toggle">
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="assistant-thread-menu assistant-menu-surface"
        data-assistant-skin
        side="bottom"
        sideOffset={6}
      >
        {onPin === undefined ? null : (
          <DropdownMenuItem
            className="assistant-thread-menu__item"
            onClick={() => {
              onPin(thread.id, !isPinned)
            }}
          >
            <PinGlyph aria-hidden="true" />
            <span>{isPinned ? '取消固定' : '固定'}</span>
          </DropdownMenuItem>
        )}

        {canRename && onBeginRename !== undefined ? (
          <DropdownMenuItem
            className="assistant-thread-menu__item"
            onClick={() => {
              setWantsRename(true)
            }}
          >
            <Pencil aria-hidden="true" />
            <span>重命名</span>
          </DropdownMenuItem>
        ) : null}

        {onExport === undefined ? null : (
          <DropdownMenuItem
            className="assistant-thread-menu__item"
            onClick={() => {
              onExport(thread.id)
            }}
          >
            <Download aria-hidden="true" />
            <span>导出会话</span>
          </DropdownMenuItem>
        )}

        {contributed.length === 0 ? null : (
          <>
            <DropdownMenuSeparator />

            {contributed.map(({ featureId, item }) => (
              <DropdownMenuItem
                className="assistant-thread-menu__item"
                key={`${featureId}:${item.id}`}
                onClick={() => {
                  void item.run(thread)
                }}
              >
                <span>{item.title}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ThreadTitleMenu({ onExport, onPin, onRename, thread }: ThreadTitleMenuProps): ReactNode {
  const [isRenaming, setRenaming] = useState(false)

  if (thread === undefined) {
    return null
  }

  const beginRename = (): void => {
    setRenaming(true)
  }

  return (
    <div className="conversation-title">
      <Laptop aria-hidden="true" className="conversation-title__icon" />

      {isRenaming && onRename !== undefined ? (
        <TitleRenameField
          initial={thread.title}
          onCancel={() => {
            setRenaming(false)
          }}
          onCommit={(title) => {
            setRenaming(false)
            const next = title.trim()
            if (next.length > 0) {
              onRename(thread.id, next)
            }
          }}
        />
      ) : (
        <TitleLabel onRename={onRename === undefined ? undefined : beginRename} title={thread.title} />
      )}

      {/* 下拉箭头：自己一枚按钮，开菜单。改名期间也留着 —— 菜单里还有别的动作。 */}
      {isRenaming ? null : (
        <ThreadActionsMenu
          canRename={onRename !== undefined}
          onBeginRename={onRename === undefined ? undefined : beginRename}
          onExport={onExport}
          onPin={onPin}
          thread={thread}
        />
      )}
    </div>
  )
}
