import './assistant-threads.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { Check, FolderClosed, ListFilter, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { focusOnMount } from '../primitives/focus-on-mount'
import { ChevronDownIcon, FolderPlusIcon, SearchIcon } from '../primitives/icons'

/*
 * 当前的工作目录，以及换一个 —— 侧栏的第一行（此前另有一栏「工作区」段标题加一枚
 * 加号，两个标题说同一件事，留两个就是把一件事说两遍）。行本身没有悬停：它不是动作，
 * 整行唯一的动作是右侧那枚图标。「最近」不是一份新名单：已有对话的工作区就是最近用过
 * 的，那份分组侧栏本来就在画（threads/thread-order 的 groupByWorkspace），从 props
 * 进来，不新开存储；当前那一个与名字缺席的那一组不出现在名单里 —— 行上写着的就是它，
 * 而后者不是一个可以切过去的地方。这一层不认识文件系统也不认识 Tauri：目录选择器是
 * 宿主的能力，从 onBrowse 进来（架构规则 nativeAllowed 只放行 desktop / native-bridge
 * / ipc）。搜索词是这张弹层的草稿：关掉就清，不落盘，也不出这个组件。
 */

/** 一个可以切过去的工作区：id 是绝对路径，name 是它最后一段。 */
export interface WorkspaceChoice {
  readonly id: string
  readonly name: string
}

export interface WorkspacePickerProps {
  /** 此刻在哪个工作目录里。还没选过就是 null。 */
  readonly current: WorkspaceChoice | null
  readonly choices: readonly WorkspaceChoice[]
  readonly onChoose: (rootPath: string) => void
  /** 清除项目选择；下一条会话获得独立的临时工作目录。缺席 = 这一处不接受「不在项目中工作」，两处入口都不画。 */
  readonly onClear?: (() => void) | undefined
  /** 开系统的文件夹选择器。这一层不知道那是怎么开的。 */
  readonly onBrowse: () => void
  /** 侧栏行，或者新对话输入框下方的上下文栏。 */
  readonly placement?: 'sidebar' | 'composer'
}

/**
 * 与本次搜索匹配的项目：名称与完整路径都参与，只返回原有对象不复制数据。
 * 搜索与开合、高亮、文件选择无关，不进 WorkspacePicker 主函数的分支。
 */
function matchingWorkspaceChoices(
  choices: readonly WorkspaceChoice[],
  query: string,
): readonly WorkspaceChoice[] {
  const needle = query.trim().toLowerCase()

  if (needle.length === 0) {
    return choices
  }

  return choices.filter(
    (choice) =>
      choice.name.toLowerCase().includes(needle) || choice.id.toLowerCase().includes(needle),
  )
}

/**
 * 项目菜单中唯一保持高亮的项目，只算视觉高亮不切换工作区。优先级：指针或键盘
 * 最后经过且仍在结果中的 > 当前项目 > 第一条搜索结果 > null。
 */
function preferredWorkspaceHighlight(
  choices: readonly WorkspaceChoice[],
  heldId: string | null,
  current: WorkspaceChoice | null,
): string | null {
  if (heldId !== null && choices.some((choice) => choice.id === heldId)) {
    return heldId
  }

  if (current !== null && choices.some((choice) => choice.id === current.id)) {
    return current.id
  }

  return choices[0]?.id ?? null
}

export function WorkspacePicker({
  choices,
  current,
  onBrowse,
  onChoose,
  onClear,
  placement = 'sidebar',
}: WorkspacePickerProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(true)

  /* Base UI 的 data-highlighted 指针离开菜单就被清掉；这里要的是更稳的「预选」：离开弹窗仍保留，直到指向另一个项目。 */
  const [heldHighlightId, setHeldHighlightId] = useState<string | null>(null)

  const matches = matchingWorkspaceChoices(choices, query)

  const activeHighlightId = preferredWorkspaceHighlight(matches, heldHighlightId, current)

  /* 有目录、且这一处接受「不在项目中」时，左边那一格才存在。 */
  const clearable = current !== null && onClear !== undefined

  return (
    <div className="workspace-picker" data-assistant-skin data-placement={placement}>
      <DropdownMenu
        modal={false}
        onOpenChange={(nextOpen) => {
          /* 每次打开重选初始高亮（当前项目，否则列表第一条）；后续移动只替换这个 id，不会留下多个高亮。 */
          if (nextOpen) {
            setHeldHighlightId(preferredWorkspaceHighlight(choices, null, current))
          }

          setOpen(nextOpen)

          /* 搜索词是这一次弹层的草稿，关了就清。 */
          if (!nextOpen) {
            setQuery('')
          }
        }}
        open={open}
      >
        {placement === 'composer' ? (
          <div
            className="workspace-picker__context-control"
            data-projectless={clearable ? undefined : 'true'}
          >
            {clearable ? (
              <button
                aria-label="不在项目中工作"
                className="workspace-picker__context-clear"
                onClick={() => {
                  setOpen(false)
                  onClear?.()
                }}
                type="button"
              >
                <FolderClosed aria-hidden="true" className="workspace-picker__context-folder" />
                <X aria-hidden="true" className="workspace-picker__context-x" />
              </button>
            ) : null}

            <DropdownMenuTrigger
              aria-label="切换项目"
              className="workspace-picker__context-trigger"
            >
              {current === null ? <FolderClosed aria-hidden="true" /> : null}

              <span className="workspace-picker__context-name">{current?.name ?? '选择项目'}</span>
            </DropdownMenuTrigger>
          </div>
        ) : (
          <>
            <button
              aria-expanded={expanded}
              className="workspace-picker__repositories-title"
              onClick={() => {
                setOpen(false)
                setExpanded((held) => !held)
              }}
              type="button"
            >
              <span>Repositories</span>

              <ChevronDownIcon
                aria-hidden="true"
                className="workspace-picker__repositories-chevron"
              />
            </button>

            <span className="workspace-picker__repositories-actions">
              <DropdownMenuTrigger
                aria-label="筛选和切换工作区"
                className="workspace-picker__repositories-action"
              >
                <ListFilter aria-hidden="true" />
              </DropdownMenuTrigger>

              <button
                aria-label="添加工作区"
                className="workspace-picker__repositories-action"
                onClick={() => {
                  setOpen(false)
                  onBrowse()
                }}
                type="button"
              >
                <FolderPlusIcon aria-hidden="true" />
              </button>
            </span>
          </>
        )}

        <DropdownMenuContent
          align={placement === 'composer' ? 'start' : 'end'}
          className="workspace-picker__menu assistant-menu-surface"
          data-assistant-skin
          side="bottom"
          sideOffset={4}
        >
          {/* 搜索是弹层的标题栏。菜单的 typeahead 与输入框抢键盘，按键不上冒 —— Escape 除外：关弹层是它本来的事。 */}
          <div className="workspace-picker__field">
            <SearchIcon aria-hidden="true" />

            <input
              aria-label="搜索项目"
              className="workspace-picker__search"
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') {
                  event.stopPropagation()
                }
              }}
              placeholder="搜索项目…"
              ref={focusOnMount}
              type="search"
              value={query}
            />
          </div>

          {matches.map((choice) => {
            const selected = choice.id === current?.id

            return (
              <DropdownMenuItem
                className="workspace-picker__item"
                data-current={selected ? 'true' : undefined}
                data-persisted-highlight={choice.id === activeHighlightId ? 'true' : undefined}
                data-workspace-choice="true"
                key={choice.id}
                onClick={() => {
                  onChoose(choice.id)
                }}
                onFocus={() => {
                  setHeldHighlightId(choice.id)
                }}
                onPointerMove={() => {
                  setHeldHighlightId(choice.id)
                }}
              >
                <FolderClosed aria-hidden="true" />

                <span className="workspace-picker__item-name">{choice.name}</span>

                {selected ? <Check aria-hidden="true" className="workspace-picker__check" /> : null}
              </DropdownMenuItem>
            )
          })}

          {matches.length === 0 ? (
            <p className="workspace-picker__none">
              {choices.length === 0 ? '还没有项目。' : '没有匹配的项目。'}
            </p>
          ) : null}

          <DropdownMenuSeparator className="workspace-picker__separator" />

          <DropdownMenuItem className="workspace-picker__item" onClick={onBrowse}>
            <Plus aria-hidden="true" />

            <span className="workspace-picker__item-name">新建项目</span>
          </DropdownMenuItem>

          {clearable ? (
            <DropdownMenuItem
              className="workspace-picker__item"
              onClick={() => {
                onClear?.()
              }}
            >
              <X aria-hidden="true" />

              <span className="workspace-picker__item-name">不在项目中工作</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
