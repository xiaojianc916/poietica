import { useCopy } from '@poietica/design-system'
import { type ComponentProps, createContext, type ReactNode, useContext, useRef } from 'react'
import { extractTableDataFromElement, tableDataToMarkdown } from 'streamdown'
import { CheckIcon, CopyIcon, DownloadIcon } from '../primitives/icons'

export type SaveTable = (content: string) => Promise<void>

const TableExportContext = createContext<SaveTable | null>(null)
const ACTION_CLASS =
  'grid size-7 place-items-center rounded-md border-0 bg-transparent text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40'

export function TableExportProvider({
  children,
  save,
}: {
  readonly children: ReactNode
  readonly save: SaveTable
}) {
  return <TableExportContext.Provider value={save}>{children}</TableExportContext.Provider>
}

type TableProps = ComponentProps<'table'> & { readonly node?: unknown }

function markdownOf(table: HTMLTableElement): string {
  return tableDataToMarkdown(extractTableDataFromElement(table))
}

export function ExportableTable({ children, className, node: _node, ...props }: TableProps) {
  const save = useContext(TableExportContext)
  const table = useRef<HTMLTableElement>(null)
  const { copied, copy } = useCopy()
  const CopyStateIcon = copied ? CheckIcon : CopyIcon

  const copyMarkdown = (): void => {
    const element = table.current

    if (element !== null) {
      copy(markdownOf(element))
    }
  }

  const downloadMarkdown = (): void => {
    const element = table.current

    if (element === null || save === null) {
      return
    }

    void save(markdownOf(element)).catch(() => window.alert('表格下载失败，请重试。'))
  }

  return (
    <div
      className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
      data-streamdown="table-wrapper"
    >
      <div className="flex items-center justify-end gap-1">
        <button
          aria-label={copied ? '已复制 Markdown 表格' : '复制表格 Markdown'}
          className={ACTION_CLASS}
          data-copied={copied ? 'true' : undefined}
          onClick={copyMarkdown}
          title="复制表格 Markdown"
          type="button"
        >
          <CopyStateIcon aria-hidden="true" size={14} />
        </button>
        <button
          aria-label="下载表格 Markdown"
          className={ACTION_CLASS}
          disabled={save === null}
          onClick={downloadMarkdown}
          title="下载表格 Markdown"
          type="button"
        >
          <DownloadIcon aria-hidden="true" size={14} />
        </button>
      </div>
      <div className="border-collapse overflow-x-auto overflow-y-auto rounded-md border border-border bg-background">
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
