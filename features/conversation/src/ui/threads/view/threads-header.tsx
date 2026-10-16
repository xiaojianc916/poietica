import './threads-header.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@poietica/design-system'
import { ListFilter, Menu, Plus, Search, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ARCHIVED_FILTER, type ArchivedFilter, GROUP_BY, type GroupBy } from './thread-view'

/*
 * 「项目」那个组头右侧的三枚按钮 —— 正本是 DeepSeek Harness 的 WorkspaceBrowser
 * sectionHeader（装机版本见 @deepseek-ai/dsh-client-ui-workspace 的 lib/client.js）：
 * 一条靠右对齐、间距 4 的工具栏，里面是 28×28 的图标钮，顺序固定为
 * 搜索 → 视图选项 → 添加。加号原先在组头里（标题右边、三枚之前），按正本挪到了这一条的最右。
 *
 * 这一层只画控件：三枚各自要什么（搜什么、怎么分组、往哪儿加）全部从 props 进来，
 * 组件不认识线程列表、也不认识文件系统。
 *
 * 正本那 36/28 是它自己那条栏的度量。这里落在本仓的会话列里，行几何一律读 --ui-row-* 一族
 * （与组头、会话行同一批令牌）—— 这一列上下几段各读一套就会不同高。
 *
 * 悬停提示读的时长由外壳的 TooltipProvider 给（workbench.tsx，450ms），与正本的 delayMs 500 同档。
 */

/** 三枚按钮此刻的取值与它们的回调。 */
export interface ThreadsHeaderProps {
  /** 搜索是否展开。这一格是**受控**的：展开时同一栏上的标题要一起让位（正本 sectionHeader 的编排）。 */
  readonly expanded: boolean
  readonly onExpandedChange: (value: boolean) => void
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly groupBy: GroupBy
  readonly onGroupByChange: (value: GroupBy) => void
  readonly archivedFilter: ArchivedFilter
  readonly onArchivedFilterChange: (value: ArchivedFilter) => void
  readonly onAdd: () => void
}

export function ThreadsHeader({
  archivedFilter,
  expanded,
  groupBy,
  onAdd,
  onArchivedFilterChange,
  onExpandedChange,
  onGroupByChange,
  onQueryChange,
  query,
}: ThreadsHeaderProps): ReactNode {
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  /* 展开之后焦点直接落进输入框（正本在这一档上没有别的中间态）。 */
  useEffect(() => {
    if (expanded) {
      input.current?.focus()
    }
  }, [expanded])

  /* 收起一律连着清词：留着词而看不见输入框，列表会停在一个用户说不出原因的筛里。 */
  const collapse = (): void => {
    onExpandedChange(false)
    onQueryChange('')
  }

  const optionRow = (value: string, label: string, Icon?: typeof ListFilter): ReactNode => (
    <DropdownMenuRadioItem value={value}>
      {Icon === undefined ? null : <Icon aria-hidden="true" />}

      <span>{label}</span>

      <DropdownMenuRadioItemIndicator />
    </DropdownMenuRadioItem>
  )

  return (
    <div className="threads-header" data-expanded={expanded ? 'true' : undefined}>
      <div className="threads-header__search" data-expanded={expanded ? 'true' : undefined}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-expanded={expanded}
                aria-label="搜索会话"
                className="threads-header__search-button"
                onClick={() => {
                  if (expanded) {
                    collapse()
                    return
                  }
                  onExpandedChange(true)
                }}
                type="button"
              >
                <Search aria-hidden="true" />
              </button>
            }
          />

          <TooltipContent side="bottom">搜索</TooltipContent>
        </Tooltip>

        <input
          aria-label="搜索会话名称"
          className="threads-header__input"
          onChange={(event) => {
            onQueryChange(event.target.value)
          }}
          onKeyDown={(event) => {
            /* 词的清理由 collapse 一处负责：这里只把「按了 Escape」这件事报上去。 */
            if (event.key === 'Escape') {
              collapse()
            }
          }}
          placeholder="搜索会话名称"
          ref={input}
          tabIndex={expanded ? 0 : -1}
          type="text"
          value={query}
        />

        {expanded ? (
          <button aria-label="清除搜索" className="threads-header__clear" onClick={collapse} type="button">
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="threads-header__actions">
        <DropdownMenu
          modal={false}
          onOpenChange={(open) => {
            setViewOptionsOpen(open)
          }}
          open={viewOptionsOpen}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger aria-label="视图选项" className="threads-header__icon-button">
                  <Menu aria-hidden="true" />
                </DropdownMenuTrigger>
              }
            />

            <TooltipContent side="bottom">视图选项</TooltipContent>
          </Tooltip>

          <DropdownMenuContent align="end" className="threads-header__menu" data-assistant-skin side="bottom">
            <DropdownMenuLabel>分组方式</DropdownMenuLabel>

            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                onGroupByChange(value as GroupBy)
                setViewOptionsOpen(false)
              }}
              value={groupBy}
            >
              {optionRow(GROUP_BY.workspace, '按工作区', ListFilter)}

              {optionRow(GROUP_BY.flat, '单列表')}
            </DropdownMenuRadioGroup>

            <DropdownMenuLabel>筛选会话</DropdownMenuLabel>

            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                onArchivedFilterChange(value as ArchivedFilter)
                setViewOptionsOpen(false)
              }}
              value={archivedFilter}
            >
              {optionRow(ARCHIVED_FILTER.hide, '隐藏已归档')}

              {optionRow(ARCHIVED_FILTER.show, '全部对话（显示已归档）')}

              {optionRow(ARCHIVED_FILTER.only, '仅显示已归档')}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger
            render={
              <button aria-label="添加工作区" className="threads-header__icon-button" onClick={onAdd} type="button">
                <Plus aria-hidden="true" />
              </button>
            }
          />

          <TooltipContent side="bottom">添加工作区</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
