import type { BrowserElementPicked } from '@poietica/ipc'

function protect(value: string): string {
  return value.replace(/<\/element_context/giu, '&lt;/element_context')
}

function indented(value: string): string {
  return protect(value)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

function sourceLocation(picked: BrowserElementPicked): string {
  if (picked.sourceFile === '') {
    return ''
  }
  const line = picked.sourceLine === null ? '' : `:${String(picked.sourceLine)}`
  const column = picked.sourceColumn === null ? '' : `:${String(picked.sourceColumn)}`
  return picked.sourceFile + line + column
}

export function formatBrowserElementContext(picked: BrowserElementPicked): string {
  const tag = picked.tagName === '' ? 'element' : picked.tagName
  const label = picked.componentName === '' ? tag : picked.componentName
  const location = sourceLocation(picked)
  const heading =
    location === '' ? `- <${protect(label)}>:` : `- <${protect(label)}> (${protect(location)}):`
  const lines = ['<element_context>', heading, `  url: ${protect(picked.url)}`]
  if (picked.selector !== null) {
    lines.push(`  selector: ${protect(picked.selector)}`)
  }
  if (location !== '') {
    lines.push(`  source: ${protect(location)}`)
  }
  if (picked.role !== '') {
    lines.push(`  role: ${protect(picked.role)}`)
  }
  if (picked.ariaLabel !== '') {
    lines.push(`  aria-label: ${protect(picked.ariaLabel)}`)
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
  if (picked.styleChanges !== '') {
    lines.push('  changes:', indented(picked.styleChanges))
  }
  if (picked.stack !== '') {
    lines.push('  component_stack:', indented(picked.stack))
  }
  lines.push('</element_context>')
  const comment = picked.comment.trim()
  return comment === '' ? lines.join('\n') : `${comment}\n\n${lines.join('\n')}`
}
