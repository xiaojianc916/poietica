import { hostBridge } from '../host-bridge'

/*
 * 保存对话框是宿主能力：它挂在窗口上，只有 Electron 主进程开得出（原生侧的
 * table_export 因此是空壳，已随这次改动从命令面删掉）。内容本来就在渲染层，
 * 所以这一条不过命令面 —— 直接交给宿主端口，由主进程弹对话框并落盘。
 */

/** 表格导出的两种落盘格式；扩展名由宿主按它选。 */
export type TableExportFormat = 'csv' | 'markdown'

export interface TableExportRequest {
  readonly content: string
  readonly format: TableExportFormat
}

/** 把表格保存到系统对话框选出的路径；用户取消即 false。 */
export function exportTable(request: TableExportRequest): Promise<boolean> {
  return hostBridge().host.saveExport(request)
}
