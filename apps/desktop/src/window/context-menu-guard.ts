/**
 * 原生右键菜单一律拦掉。
 *
 * 主窗口是 decorations: false，而 WebView2 的页面右键菜单给的是「返回 / 刷新 /
 * 另存为 / 打印 / 检查」。这不是多余，是危险：刷新会重载整个 SPA、内存里的对话
 * 状态全丢；另存为把应用的 HTML 写到磁盘；返回让唯一的 webview 导航走 —— 正是
 * external-links.ts 文件头描述的那个回不来的局面。可编辑元素也不例外：那张菜单
 * 是 WebView2 的（宿主字体、图标、「检查」），它当场告诉用户你在看一个网页。
 *
 * 在这一层拦而不是关 WebView2 的 AreDefaultContextMenusEnabled：后者 Tauri 2.5
 * 没有配置化，且只管 Windows。「全局、谁也不该知道」这类问题走 document 级
 * capture 监听（见 external-links.ts），不新开机制。
 *
 * 代价：鼠标粘贴没有了，键盘 Ctrl+X / Ctrl+C / Ctrl+V 不受影响。将来自绘菜单在
 * 冒泡阶段自己 preventDefault，下面那句 defaultPrevented 就是留给它的接口。
 */

export function installContextMenuGuard(): () => void {
  const onContextMenu = (event: MouseEvent): void => {
    /*
     * 已经被拦过就不再插手：将来自绘菜单会在冒泡阶段自己 preventDefault，
     * 这里没有理由重复表态。
     */
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
