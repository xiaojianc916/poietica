/* Chromium 的原生右键菜单（刷新、另存为、检查）会绕过应用自己的菜单，document 级
   capture 一律拦下。 */

export function installContextMenuGuard(): () => void {
  const onContextMenu = (event: MouseEvent): void => {
    if (event.defaultPrevented) {
      return
    }

    event.preventDefault()
  }

  document.addEventListener('contextmenu', onContextMenu, { capture: true })

  return () => {
    document.removeEventListener('contextmenu', onContextMenu, { capture: true })
  }
}
