import './git-branch-picker.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/ui'
import { Check, GitBranch, Plus } from 'lucide-react'
import { useState } from 'react'
import { focusOnMount } from '../primitives/focus-on-mount'
import { SearchIcon } from '../primitives/icons'

/*
 * 当前工作目录检出的分支，以及换一个。
 *
 * 它站在项目胶囊右侧，是同一条上下文栏里的第二枚 chip：项目说「在哪」，
 * 分支说「在哪条线上」。不是 git 仓库时这枚 chip 整个不存在 —— 上游不交
 * props 就不渲染，这里没有空态。
 *
 * 弹层沿用项目选择器的解剖：搜索在顶、名单在中、动作在底。创建不开第二层
 * 对话框 —— 搜索框就是命名框，输入的词匹配不到已有分支时，底部动作变成
 * 「创建并检出」它。Zed 的分支选择器就是这个形状；比二段式对话框少一层
 * 状态，也和这条上下文栏的其余部分长在同一套骨架上。
 *
 * 这一层不认识 IPC 也不持有仓库状态：快照、失败与忙碌都从 props 进来，
 * 动作从回调出去。回调交回「是否已应用」，组件唯一自有的决定是：应用了
 * 才合上弹层；失败由应用级通知管线呈现，菜单本身不复制错误状态。
 */

export interface GitBranchPickerProps {
  /** 当前检出的分支；HEAD 分离时为 null。 */
  readonly branch: string | null
  /** HEAD 分离时所在提交的短号；在分支上时为 null。 */
  readonly detachedAt: string | null
  /** 本地分支，按最近提交排序。 */
  readonly branches: readonly string[]
  /** 有一次切换或创建还在路上。 */
  readonly busy: boolean
  readonly onSwitch: (branch: string) => Promise<boolean>
  readonly onCreate: (branch: string) => Promise<boolean>
  /** 弹层每次打开时刷新快照：分支可能刚在终端里被人动过。 */
  readonly onRefresh: () => void
}

function matchingBranches(branches: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase()

  if (needle.length === 0) {
    return branches
  }

  return branches.filter((name) => name.toLowerCase().includes(needle))
}

export function GitBranchPicker({
  branch,
  branches,
  busy,
  detachedAt,
  onCreate,
  onRefresh,
  onSwitch,
}: GitBranchPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const matches = matchingBranches(branches, query)
  const draft = query.trim()

  /* 敲进来的名字还不存在，才谈得上创建；重名让 git 拒绝一次不如不给入口。 */
  const creatable = draft.length > 0 && !branches.includes(draft)

  const label = branch ?? (detachedAt === null ? '' : `分离于 ${detachedAt}`)

  const settle = (applied: boolean) => {
    if (applied) {
      setOpen(false)
    }
  }

  return (
    <div className="git-branch-picker">
      <DropdownMenu
        modal={false}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          setQuery('')

          if (nextOpen) {
            onRefresh()
          }
        }}
        open={open}
      >
        <DropdownMenuTrigger
          aria-label="切换分支"
          className="git-branch-picker__trigger"
          title={label}
        >
          <GitBranch aria-hidden="true" />

          <span className="git-branch-picker__name">{label}</span>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          className="git-branch-picker__menu assistant-menu-surface"
          data-assistant-skin
          side="bottom"
          sideOffset={4}
        >
          {/* 搜索兼命名。按键不上冒，Escape 除外 —— 关弹层是它本来的事。 */}
          <div className="git-branch-picker__field">
            <SearchIcon aria-hidden="true" />

            <input
              aria-label="搜索或新建分支"
              className="git-branch-picker__search"
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') {
                  event.stopPropagation()
                }
              }}
              placeholder="搜索或新建分支…"
              ref={focusOnMount}
              type="search"
              value={query}
            />
          </div>

          {matches.map((name) => {
            const selected = name === branch

            return (
              <DropdownMenuItem
                className="git-branch-picker__item"
                closeOnClick={false}
                data-current={selected ? 'true' : undefined}
                disabled={busy}
                key={name}
                onClick={() => {
                  if (selected) {
                    setOpen(false)

                    return
                  }

                  void onSwitch(name).then(settle)
                }}
              >
                <GitBranch aria-hidden="true" />

                <span className="git-branch-picker__item-name">{name}</span>

                {selected ? (
                  <Check aria-hidden="true" className="git-branch-picker__check" />
                ) : null}
              </DropdownMenuItem>
            )
          })}

          {matches.length === 0 && !creatable ? (
            <p className="git-branch-picker__none">没有匹配的分支。</p>
          ) : null}

          <DropdownMenuSeparator className="git-branch-picker__separator" />

          <DropdownMenuItem
            className="git-branch-picker__item"
            closeOnClick={false}
            disabled={!creatable || busy}
            onClick={() => {
              void onCreate(draft).then(settle)
            }}
          >
            <Plus aria-hidden="true" />

            <span className="git-branch-picker__item-name">
              {creatable ? `创建并检出「${draft}」` : '创建并检出新分支…'}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
