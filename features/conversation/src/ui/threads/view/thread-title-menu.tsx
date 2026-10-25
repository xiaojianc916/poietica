import './thread-title-menu.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { useContributions } from '@poietica/ui-kernel'
import { ChevronDown, Copy, Download, Laptop, Link2, Pencil, Pin, PinOff } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import type { Thread } from '../../../contract'
import { threadActions } from '../../../ui-api'

/*
 * 标题**不缓存**：整格从 `thread` prop 读，调用方订阅着线程库。标题本身就是改名的入口，下拉箭头才开菜单；标题上不挂原生 title 提示 —— 它的悬停气泡与「点标题改名」会打架。
 */

export interface ThreadTitleMenuProps {
  readonly thread: Thread | undefined
  readonly onPin?: ((threadId: string, pinned: boolean) => void) | undefined
  readonly onRename?: ((threadId: string, title: string) => void) | undefined
  readonly onExport?: ((threadId: string) => void) | undefined
  /** 用 omp 的分享生成会话链接并复制；空会话由 Core 报 thread_empty */
  readonly onShare?: ((threadId: string) => void) | undefined
  /** 复制这条对话的 omp Session ID（`omp --resume <id>` 认它）。还没有会话文件时没有 id，那一项不画 */
  readonly onCopySessionId?: ((threadId: string) => void) | undefined
  /**
   * 从外面进改名（斜杠命令 `/rename`）：每变一次就进一次就地改名，与点标题同一个编辑框。
   * 计数而不是布尔：改完再敲一次 `/rename` 也得再进一次。
   */
  readonly renameRequest?: number | undefined
  /**
   * 正在按对话内容生成标题（不带标题的 `/rename`）：标题那一格换成一道扫光的「正在生成标题…」，
   * 新标题到了（线程库推回来）或生成失败（横幅另说）时由调用方收回。
   */
  readonly titling?: boolean | undefined
}

const TITLING = '正在生成标题…'

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
   * ref 用 useCallback 钉住标识，不然每敲一个字都会重新全选。显式 focus 是必需的：从菜单点「重命名」进来时焦点还在被卸载的弹层上，
   * 不抢回来输入框可能在拿到焦点前吃到一次 blur，编辑框当场收掉（真机表现为「点了没反应」）。
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
  titling,
}: {
  readonly onRename: (() => void) | undefined
  readonly title: string
  readonly titling: boolean
}): ReactNode {
  const text = (
    <span className="conversation-title__text" data-titling={titling ? 'true' : undefined}>
      {titling ? TITLING : title}
    </span>
  )

  /* 生成中不给点：此刻手动改名会和马上到的新标题互相盖 */
  if (onRename === undefined || titling) {
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
  onCopySessionId,
  onExport,
  onPin,
  onShare,
  thread,
}: {
  readonly canRename: boolean
  readonly onBeginRename: (() => void) | undefined
  readonly onCopySessionId: ((threadId: string) => void) | undefined
  readonly onExport: ((threadId: string) => void) | undefined
  readonly onPin: ((threadId: string, pinned: boolean) => void) | undefined
  readonly onShare: ((threadId: string) => void) | undefined
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
        className="assistant-thread-menu"
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
            <span>{isPinned ? '取消置顶' : '置顶会话'}</span>
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

        {onShare === undefined ? null : (
          <DropdownMenuItem
            className="assistant-thread-menu__item"
            onClick={() => {
              onShare(thread.id)
            }}
          >
            <Link2 aria-hidden="true" />
            <span>复制会话链接</span>
          </DropdownMenuItem>
        )}

        {/*
         * 复制 Session ID：与 DSH 同一档位置（菜单末尾、贡献动作之前）、同一句文案。
         * id 缺席就不画 —— 还没发过话的对话没有 omp 会话，那一格没有东西可复制。
         */}
        {onCopySessionId === undefined || thread.sessionId === null ? null : (
          <DropdownMenuItem
            className="assistant-thread-menu__item"
            onClick={() => {
              onCopySessionId(thread.id)
            }}
          >
            <Copy aria-hidden="true" />
            <span>复制 Session ID</span>
          </DropdownMenuItem>
        )}

        {contributed.length === 0 ? null : (
          <>
            <DropdownMenuSeparator />

            {contributed.map(({ featureId, item }) => {
              /*
               * 贡献项自报字形（automations 的创建定时任务是闹钟）；没给就只画字，
               * 不塞占位图标 —— 一行里空一格比一个不是它的字形更容易读错。
               */
              const Icon = item.icon

              return (
                <DropdownMenuItem
                  className="assistant-thread-menu__item"
                  key={`${featureId}:${item.id}`}
                  onClick={() => {
                    void item.run(thread)
                  }}
                >
                  {Icon === undefined ? null : <Icon aria-hidden="true" />}
                  <span>{item.title}</span>
                </DropdownMenuItem>
              )
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ThreadTitleMenu({
  onCopySessionId,
  onExport,
  onPin,
  onRename,
  onShare,
  renameRequest,
  thread,
  titling = false,
}: ThreadTitleMenuProps): ReactNode {
  const [isRenaming, setRenaming] = useState(false)
  const [seenRequest, setSeenRequest] = useState(renameRequest)

  /* 渲染期对比上一次的请求号（「props 变了就调 state」），编辑框挂上时自己抢焦点、全选 */
  if (seenRequest !== renameRequest) {
    setSeenRequest(renameRequest)
    if (renameRequest !== undefined && onRename !== undefined && thread !== undefined) {
      setRenaming(true)
    }
  }

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
        <TitleLabel
          onRename={onRename === undefined ? undefined : beginRename}
          title={thread.title}
          titling={titling}
        />
      )}

      {/* 下拉箭头：自己一枚按钮，开菜单。改名期间也留着 —— 菜单里还有别的动作。 */}
      {isRenaming ? null : (
        <ThreadActionsMenu
          canRename={onRename !== undefined}
          onBeginRename={onRename === undefined ? undefined : beginRename}
          onCopySessionId={onCopySessionId}
          onExport={onExport}
          onPin={onPin}
          onShare={onShare}
          thread={thread}
        />
      )}
    </div>
  )
}
