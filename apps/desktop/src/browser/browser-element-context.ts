import type { BrowserElementPicked } from '@poietica/ipc'

function protect(value: string): string {
  return value.replaceAll('</element_context>', '&lt;/element_context>')
}

function indented(value: string): string {
  return protect(value)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

export function formatBrowserElementContext(picked: BrowserElementPicked): string {
  const tag = picked.tagName === '' ? 'element' : picked.tagName
  const lines = [
    '<element_context>',
    `- <${tag}>:`,
    `  url: ${protect(picked.url)}`,
    `  selector: ${protect(picked.selector)}`,
  ]
  if (picked.role !== '') {
    lines.push(`  role: ${protect(picked.role)}`)
  }
  if (picked.accessibleName !== '') {
    lines.push(`  name: ${protect(picked.accessibleName)}`)
  }
  if (picked.text !== '') {
    lines.push(`  text: ${protect(picked.text)}`)
  }
  if (picked.html !== '') {
    lines.push('  html:', indented(picked.html))
  }
  if (picked.styles !== '') {
    lines.push('  styles:', indented(picked.styles))
  }
  lines.push('</element_context>')
  const comment = picked.comment.trim()
  return comment === '' ? lines.join('\n') : `${comment}\n\n${lines.join('\n')}`
}
