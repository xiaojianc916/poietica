import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExportableTable } from '../timeline/table-export'
import { TableExportProvider } from '../timeline/table-export-context'

describe('表格操作', () => {
  it('只呈现可用的 Markdown 复制与下载动作', () => {
    const markup = renderToStaticMarkup(
      <TableExportProvider save={async () => undefined}>
        <ExportableTable>
          <thead>
            <tr>
              <th>名称</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>值</td>
            </tr>
          </tbody>
        </ExportableTable>
      </TableExportProvider>,
    )

    expect(markup).toContain('aria-label="复制表格 Markdown"')
    expect(markup).toContain('aria-label="下载表格 Markdown"')
    expect(markup).not.toContain('CSV')
    expect(markup).not.toContain('TSV')
    expect(markup).not.toContain('disabled=""')
  })
})
