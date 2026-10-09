import { formatByteSize } from './file-size'

export function fileExtensionLabel(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  return extension === '' ? '文件' : extension.slice(0, 5).toUpperCase()
}

export function fileMetaLabel(name: string, size: number | undefined): string {
  const kind = fileExtensionLabel(name)
  const bytes = formatByteSize(size)
  return bytes === undefined ? kind : `${kind} ${bytes}`
}
