/** 命令面板的开合：内核之外的一格瞬时状态，由 Workbench 订阅 */
const listeners = new Set<() => void>()
let open = false

export function openPalette(): void {
  open = true
  for (const l of [...listeners]) l()
}

export function closePalette(): void {
  open = false
  for (const l of [...listeners]) l()
}

export function subscribePalette(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function paletteSnapshot(): boolean {
  return open
}
