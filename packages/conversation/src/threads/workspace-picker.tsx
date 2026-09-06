import '../surface/assistant.css'

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
 * 当前的工作目录，以及换一个。
 *
 * 它是侧栏的第一行 —— 此前这里另有一栏「工作区」段标题加一枚加号，两个
 * 标题说的是同一件事，留两个就是把一件事说两遍。现在只剩这一行：名字在
 * 左，右侧那枚打开文件夹的图标，站在段标题时代那枚加号的位置上。
 *
 * 行本身没有悬停：它不是动作，只说「现在在哪」。整行唯一的动作是右侧那
 * 枚图标，所以悬停也只属于它。点开一张弹层：上面是搜索，中间是最近的
 * 工作目录，下面是「打开文件夹…」。条目带目录字形，动作带 FolderPlus ——
 * 一张纯文字的菜单读起来是一张便签，不是选择器。
 *
 * 「最近」不是一份新名单。已经有对话的工作区就是最近用过的工作区，而那份
 * 分组侧栏本来就在画（agent-session 的 groupByWorkspace）—— 所以它从
 * props 进来，不新开存储，也不会有第二份会跟真相分叉的记录。当前那一个
 * 不出现在名单里：行上写着的就是它，再列一遍只是一个点了没有反应的选项。
 * 名字缺席的那一组也不出现 —— 那一组说的是「目录没被记下来」，它不是
 * 一个可以切过去的地方。
 *
 * 这一层不认识文件系统，也不认识 Tauri：目录选择器是宿主的能力，从
 * onBrowse 进来（架构规则 nativeAllowed 只放行 desktop / native-bridge
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
  /** 清除项目选择；下一条会话会获得独立的临时工作目录。 */
  readonly onClear: () => void
  /** 开系统的文件夹选择器。这一层不知道那是怎么开的。 */
  readonly onBrowse: () => void
  /** 侧栏行，或者新对话输入框下方的上下文栏。 */
  readonly placement?: 'sidebar' | 'composer'
}

/**
 * 返回与本次搜索匹配的项目。
 *
 * 搜索与组件的开合、高亮和文件选择无关，所以不应成为 WorkspacePicker 主函数
 * 的分支。项目名称和完整路径都可以参与搜索，但只返回原有对象，不复制数据。
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
 * 决定项目菜单中唯一保持高亮的项目。
 *
 * 优先级：
 *
 * 1. 指针或键盘最后经过、并且仍在结果中的项目；
 * 2. 当前项目；
 * 3. 第一条搜索结果；
 * 4. 没有结果时为 null。
 *
 * 这个函数只计算视觉高亮，不会切换实际工作区。
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

  /*
   * Base UI 的 data-highlighted 只表示指针或键盘此刻停在哪里，指针离开菜单后
   * 会被清掉。工作区选择器需要的是更稳定的“预选项目”：离开弹窗后仍然保留，
   * 直到另一个项目被指向。
   */
  const [heldHighlightId, setHeldHighlightId] = useState<string | null>(null)

  const matches = matchingWorkspaceChoices(choices, query)

  const activeHighlightId = preferredWorkspaceHighlight(matches, heldHighlightId, current)

  return (
    <div className="workspace-picker" data-assistant-skin data-placement={placement}>
      <DropdownMenu
        modal={false}
        onOpenChange={(nextOpen) => {
          /*
           * 每次打开都重新选择初始高亮：
           *
           * - 有当前项目：当前项目；
           * - 无当前项目：列表中的第一个项目。
           *
           * 后续指针或键盘移动只会替换这个 id，因此不会同时留下多个高亮项。
           */
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
            data-projectless={current === null ? 'true' : undefined}
          >
            {current === null ? null : (
              <button
                aria-label="不在项目中工作"
                className="workspace-picker__context-clear"
                onClick={() => {
                  setOpen(false)
                  onClear()
                }}
                type="button"
              >
                <FolderClosed aria-hidden="true" className="workspace-picker__context-folder" />
                <X aria-hidden="true" className="workspace-picker__context-x" />
              </button>
            )}

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
          {/*
           * 搜索是这张弹层的标题栏。菜单的 typeahead 与输入框抢键盘，
           * 所以按键不上冒 —— Escape 除外：关弹层是它本来的事。
           */}
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

          {current === null ? null : (
            <DropdownMenuItem className="workspace-picker__item" onClick={onClear}>
              <X aria-hidden="true" />

              <span className="workspace-picker__item-name">不在项目中工作</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
