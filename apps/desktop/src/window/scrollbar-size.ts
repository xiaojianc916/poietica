const SIZE = '--desktop-scrollbar-size'

export function installScrollbarSize(): void {
  const probe = document.createElement('div')

  probe.style.position = 'absolute'
  probe.style.insetBlockStart = '0'
  probe.style.insetInlineStart = '0'
  probe.style.inlineSize = '100px'
  probe.style.blockSize = '100px'
  probe.style.overflowY = 'scroll'
  probe.style.visibility = 'hidden'

  document.body.append(probe)

  const size = probe.offsetWidth - probe.clientWidth

  probe.remove()

  document.documentElement.style.setProperty(SIZE, `${String(size)}px`)
}
