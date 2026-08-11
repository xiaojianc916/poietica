import { commands } from '@poietica/ipc/generated/ipc-bindings'

const CSV_DOWNLOAD_TITLE = '下载为 CSV'
const MARKDOWN_DOWNLOAD_TITLE = '下载为 Markdown'

type TableExportFormat = 'csv' | 'markdown'

function exportFormatOf(button: HTMLButtonElement): TableExportFormat | null {
  switch (button.title) {
    case CSV_DOWNLOAD_TITLE:
      return 'csv'
    case MARKDOWN_DOWNLOAD_TITLE:
      return 'markdown'
    default:
      return null
  }
}

function tableRows(table: HTMLTableElement): readonly (readonly string[])[] {
  return Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => {
      const text = cell.innerText || cell.textContent || ''

      return text.replaceAll('\u00a0', ' ').trim()
    }),
  )
}

function csvCell(value: string): string {
  const escaped = value.replaceAll('"', '""')

  return /[",\r\n]/u.test(value) ? `"${escaped}"` : escaped
}

function tableToCsv(rows: readonly (readonly string[])[]): string {
  const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')

  // Excel on Windows otherwise falls back to the system ANSI code page and
  // corrupts Chinese text.
  return `\uFEFF${body}\r\n`
}

function markdownCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll(/\r?\n/gu, '<br>')
}

function tableToMarkdown(rows: readonly (readonly string[])[]): string {
  const width = Math.max(0, ...rows.map((row) => row.length))

  if (width === 0) {
    return ''
  }

  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) => markdownCell(row[index] ?? '')),
  )

  const header = normalized[0] ?? Array.from({ length: width }, () => '')
  const body = normalized.slice(1)

  return [
    `| ${header.join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
    '',
  ].join('\n')
}

function contentFor(table: HTMLTableElement, format: TableExportFormat): string {
  const rows = tableRows(table)

  return format === 'csv' ? tableToCsv(rows) : tableToMarkdown(rows)
}

/**
 * Streamdown's table control saves through a temporary <a download> element.
 * That browser download path is not reliable inside the desktop WebView, so
 * format choices are intercepted and passed to the application's native,
 * path-scoped save command instead.
 */
export function installTableDownloads(): () => void {
  const onActivate = (event: MouseEvent): void => {
    if (event.button !== 0 || event.defaultPrevented) {
      return
    }

    const target = event.target

    if (!(target instanceof Element)) {
      return
    }

    const button = target.closest('button')

    if (!(button instanceof HTMLButtonElement)) {
      return
    }

    const format = exportFormatOf(button)

    if (format === null) {
      return
    }

    const wrapper = button.closest('[data-streamdown="table-wrapper"]')
    const table = wrapper?.querySelector('table')

    if (!(table instanceof HTMLTableElement)) {
      return
    }

    // Capture runs before Streamdown's React handler. Stop it here so the
    // ineffective browser Blob download does not run as a second write path.
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    const content = contentFor(table, format)

    void commands.tableExport({ content, format }).catch((cause: unknown) => {
      console.error('[Poietica] Failed to export a table', cause)
      window.alert('表格下载失败，请重试。')
    })
  }

  document.addEventListener('click', onActivate, { capture: true })

  return () => {
    document.removeEventListener('click', onActivate, { capture: true })
  }
}
