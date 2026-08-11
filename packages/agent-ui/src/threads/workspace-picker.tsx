import '../surface/assistant.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/ui'
import { Check, FolderClosed, ListFilter, X } from 'lucide-react'
import { useState } from 'react'
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
 * onBrowse 进来（架构规则 nativeAllowed 只放行 desktop / desktop-adapters
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

/*
 * 弹层一打开，搜索框就拿到焦点。
 *
 * 不用 autoFocus：那是页面加载期的语义，a11y 规则拦它是对的。callback ref 在
 * 节点真正出现的那一刻跑，正是这张弹层需要的时机。写成模块级常量而不是内联
 * 箭头，引用才稳定 —— 否则每敲一个字都会卸载重挂一次 ref。
 */
function focusOnMount(node: HTMLInputElement | null): void {
  node?.focus()
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

  const needle = query.trim().toLowerCase()
  const matches =
    needle.length === 0
      ? choices
      : choices.filter(
          (choice) =>
            choice.name.toLowerCase().includes(needle) || choice.id.toLowerCase().includes(needle),
        )

  return (
    <div
      className="workspace-picker"
      data-assistant-skin
      data-expanded={placement === 'sidebar' ? (expanded ? 'true' : 'false') : undefined}
      data-placement={placement}
    >
      <DropdownMenu
        modal={false}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)

          /* 搜索词是这一次弹层的草稿，关了就清。 */
          if (!nextOpen) {
            setQuery('')
          }
        }}
        open={open}
      >
        {placement === 'composer' ? (
          <div className="workspace-picker__context-control">
            {current === null ? null : (
              <button
                aria-label="不在项目中工作"
                className="workspace-picker__context-clear"
                onClick={() => {
                  setOpen(false)
                  onClear()
                }}
                title="不在项目中工作"
                type="button"
              >
                <FolderClosed aria-hidden="true" className="workspace-picker__context-folder" />
                <X aria-hidden="true" className="workspace-picker__context-x" />
              </button>
            )}

            <DropdownMenuTrigger
              aria-label="切换项目"
              className="workspace-picker__context-trigger"
              title={current?.id ?? '选择项目'}
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
              title={expanded ? '收起仓库和会话' : '展开仓库和会话'}
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
                title="筛选和切换工作区"
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
                title="添加工作区"
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
              aria-label="搜索工作目录"
              className="workspace-picker__search"
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') {
                  event.stopPropagation()
                }
              }}
              placeholder="搜索目录…"
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
                key={choice.id}
                onClick={() => {
                  onChoose(choice.id)
                }}
                title={choice.id}
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
            <FolderPlusIcon aria-hidden="true" />

            <span className="workspace-picker__item-name">新建项目</span>
          </DropdownMenuItem>

          <DropdownMenuItem className="workspace-picker__item" onClick={onClear}>
            <X aria-hidden="true" />

            <span className="workspace-picker__item-name">不在项目中工作</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
