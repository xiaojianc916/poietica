import type { TableExportRequest } from '@poietica/contract'
import { commands } from '@poietica/contract'

import { throughIpc } from '../error'

/** 把表格保存到系统对话框选出的路径；用户取消即 false。 */
export function exportTable(request: TableExportRequest): Promise<boolean> {
  return throughIpc(() => commands.tableExport(request))
}
