/**
 * 原生右键菜单归零，可编辑元素除外。
 *
 * 主窗口是 decorations: false，而 WebView2 的页面右键菜单给的是「返回 / 刷新 /
 * 另存为 / 打印 / 检查」。这不是多余，是危险：刷新会重载整个 SPA、内存里的对话
 * 状态全丢；另存为把应用的 HTML 写到磁盘；返回让唯一的 webview 导航走 —— 正是
 * external-links.ts 文件头描述的那个回不来的局面。
 *
 * 为什么在这一层拦，而不是关 WebView2 的 AreDefaultContextMenusEnabled：那个
 * 开关 Tauri 2.5 没有配置化，要自己接 webview2-com，而且只管 Windows。这个仓库
 * 对「全局、跨组件、谁也不该知道」这类问题已经选定了做法 —— 见 external-links
 * .ts 那条 document 级 capture 监听。同类问题用同一条管线，不新开机制。
 *
 * 可编辑元素不再例外。
 *
 * 之前放行 input / textarea / contenteditable，理由是那张编辑菜单没有危险项，
 * 一刀切会让输入框失去鼠标粘贴。这个理由站不住：那张菜单不是「我们的」菜单，
 * 它是 WebView2 的 —— 宿主的字体、宿主的图标、宿主的语言，条目里还写着「表情
 * 符号 Win+句点」「粘贴为纯文本」「书写方向」「发送标签页到你的设备」「检查」。
 * 它当场告诉用户：你在看一个网页。桌面产品不会在自己的输入框上弹出宿主浏览器
 * 的菜单，这一条没有例外可言。
 *
 * 代价明确记在这里：鼠标粘贴没有了，键盘 Ctrl+X / Ctrl+C / Ctrl+V 不受影响。
 * 等自绘编辑菜单落地，它会在冒泡阶段自己 preventDefault，下面那句
 * defaultPrevented 就是留给它的接口 —— 这个文件届时一行都不用改。
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
