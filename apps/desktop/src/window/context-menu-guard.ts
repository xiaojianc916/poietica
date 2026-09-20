/* WebView2 原生右键菜单（刷新/另存为）会毁掉 SPA 状态，document 级 capture 一律拦；Tauri 2.5 未暴露 AreDefaultContextMenusEnabled 且它只管 Windows。 */

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
