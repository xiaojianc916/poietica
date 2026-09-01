import { type ComponentProps, createContext, type ReactNode, useContext, useRef } from 'react'
import {
  extractTableDataFromElement,
  TableCopyDropdown,
  tableDataToCSV,
  tableDataToMarkdown,
} from 'streamdown'

export type TableExportFormat = 'csv' | 'markdown'
export type SaveTable = (format: TableExportFormat, content: string) => Promise<void>
const TableExportContext = createContext<SaveTable | null>(null)
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
export function ExportableTable({ children, className, node: _node, ...props }: TableProps) {
  const save = useContext(TableExportContext)
  const table = useRef<HTMLTableElement>(null)
  const exportAs = (format: TableExportFormat): void => {
    const element = table.current
    if (element === null || save === null) {
      return
    }
    const data = extractTableDataFromElement(element)
    const content =
      format === 'csv' ? `\uFEFF${tableDataToCSV(data, ',')}\r\n` : tableDataToMarkdown(data)
    void save(format, content).catch(() => window.alert('表格下载失败，请重试。'))
  }
  return (
    <div
      className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
      data-streamdown="table-wrapper"
    >
      <div className="flex items-center justify-end gap-1">
        <TableCopyDropdown />
        <button
          aria-label="下载为 CSV"
          disabled={save === null}
          onClick={() => exportAs('csv')}
          type="button"
        >
          CSV
        </button>
        <button
          aria-label="下载为 Markdown"
          disabled={save === null}
          onClick={() => exportAs('markdown')}
          type="button"
        >
          Markdown
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
