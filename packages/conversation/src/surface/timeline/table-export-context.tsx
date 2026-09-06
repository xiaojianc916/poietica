import { createContext, type ReactNode, useContext } from 'react'

export type SaveTable = (content: string) => Promise<void>

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

export function useTableExport(): SaveTable | null {
  return useContext(TableExportContext)
}
