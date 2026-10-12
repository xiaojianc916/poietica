import { useCopy } from '@poietica/design-system'
import { type ComponentProps, useRef } from 'react'
import { extractTableDataFromElement, tableDataToMarkdown } from 'streamdown'
import { CheckIcon, CopyIcon } from '../primitives/icons'

/* 表的复制键：几何归样式表（--cp-table-control），这里只留配色、圆角与转场。 */
const ACTION_CLASS =
  'grid place-items-center rounded-md border-0 bg-transparent text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'

type TableProps = ComponentProps<'table'> & { readonly node?: unknown }

function markdownOf(table: HTMLTableElement): string {
  return tableDataToMarkdown(extractTableDataFromElement(table))
}

export function ExportableTable({ children, className, node: _node, ...props }: TableProps) {
  const table = useRef<HTMLTableElement>(null)
  const { copied, copy } = useCopy()
  const CopyStateIcon = copied ? CheckIcon : CopyIcon

  /* 复制的是 Markdown 源码，不是屏幕上这份排版（历史上如此，按钮的 aria-label 也这么说）。 */
  const copyMarkdown = (): void => {
    const element = table.current

    if (element !== null) {
      copy(markdownOf(element))
    }
  }

  return (
    <div className="relative my-4 flex flex-col rounded-lg" data-streamdown="table-wrapper">
      {/*
       * 控件层在表外、靠右：它绝对定位，不参与流、也不撑宽包裹层，表格宽度仍由内容决定。
       * 它压着的是这张表自己的表头（第一行没有底色），所以按钮直接落在行带上，不用垫底。
       */}
      <div className="absolute end-0 flex items-center gap-1" data-streamdown="table-actions">
        <button
          aria-label={copied ? '已复制 Markdown 表格' : '复制表格 Markdown'}
          className={ACTION_CLASS}
          data-copied={copied ? 'true' : undefined}
          onClick={copyMarkdown}
          type="button"
        >
          <CopyStateIcon aria-hidden="true" size={14} />
        </button>
      </div>
      <div className="overflow-x-auto overflow-y-auto">
        <table
          {...props}
          className={`w-full divide-y divide-border ${className ?? ''}`}
          data-streamdown="table"
          ref={table}
        >
          {children}
        </table>
      </div>
    </div>
  )
}
