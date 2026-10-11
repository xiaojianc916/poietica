/*
 * 浮层（命令面板、确认框、设计系统的 Dialog / Popover…）出没的 DOM 观察（P-07）。
 *
 * 契约：design-system 的浮层都建在 Base UI 上，Base UI 的 FloatingPortal 不传 container 时
 * 把一个传送门 div 挂成 document.body 的**直接子节点**，弹层（role="dialog"，打开时带
 * data-open）在它里面；嵌套浮层挂在父传送门里，同样在应用根之外。应用根是渲染进程的挂载点
 * <div id="root">（apps/desktop/src/renderer/index.html、main.tsx）。
 *
 * 所以只需要看两处：body 的直接子节点（传送门来去），以及每个传送门自己的子树（弹层挂上、
 * data-open 开合）。应用根里的变动 —— 流式输出时每秒几十次 —— 一律不看。
 *
 * 找不到应用根（测试、将来改了挂载点）时退回旧做法：整棵 body 子树观察、整份文档查询。
 */

const OPEN_DIALOG = '[role="dialog"][data-open]'
const PORTAL_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-open'],
}

/** 应用根：必须是 body 的直接子节点才算数，否则当作没有 */
function appRootOf(doc: Document, appRootId: string): Element | null {
  const root = doc.getElementById(appRootId)
  return root !== null && root.parentElement === doc.body ? root : null
}

/** 此刻有没有打开的浮层。只查应用根之外的传送门，代价与浮层规模成正比，与对话长度无关。 */
export function overlayPresent(doc: Document, appRootId = 'root'): boolean {
  const root = appRootOf(doc, appRootId)
  if (root === null) return doc.querySelector(OPEN_DIALOG) !== null
  for (const child of doc.body.children) {
    if (child === root) continue
    if (child.matches(OPEN_DIALOG) || child.querySelector(OPEN_DIALOG) !== null) return true
  }
  return false
}

/** 浮层可能变了就回调 onChange（可能多报，不会漏报）。返回停止函数。 */
export function watchOverlays(doc: Document, onChange: () => void, appRootId = 'root'): () => void {
  const root = appRootOf(doc, appRootId)
  const watched = new WeakSet<Node>()
  const watch = (node: Node): void => {
    if (node === root || node.nodeType !== Node.ELEMENT_NODE || watched.has(node)) return
    watched.add(node)
    observer.observe(node, PORTAL_OPTIONS)
  }
  const observer = new MutationObserver((records) => {
    if (root !== null) {
      for (const record of records) {
        if (record.target === doc.body) record.addedNodes.forEach(watch)
      }
    }
    onChange()
  })

  if (root === null) {
    observer.observe(doc.body, PORTAL_OPTIONS)
  } else {
    /* body 只看直接子节点的来去；已有的传送门（含 keepMounted 的）各自看子树 */
    observer.observe(doc.body, { childList: true })
    for (const child of doc.body.children) watch(child)
  }
  return () => observer.disconnect()
}
