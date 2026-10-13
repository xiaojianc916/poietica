/* 浮层出没的 DOM 观察（P-07）。契约：design-system 的浮层都建在 Base UI 上，传送门 div 挂成 document.body
 * 的**直接子节点**，弹层（role="dialog"，打开时带 data-open）在它里面；嵌套浮层也都在应用根（#root）之外。
 * 所以只看两处：body 的直接子节点与每个传送门的子树，应用根里的变动一律不看。找不到应用根时退回整棵 body 子树观察。 */

const OPEN_DIALOG = '[role="dialog"][data-open]'
const PORTAL_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-open'],
}

function appRootOf(doc: Document, appRootId: string): Element | null {
  const root = doc.getElementById(appRootId)
  return root !== null && root.parentElement === doc.body ? root : null
}

/** 只查应用根之外的传送门，代价与浮层规模成正比、与对话长度无关。 */
export function overlayPresent(doc: Document, appRootId = 'root'): boolean {
  const root = appRootOf(doc, appRootId)
  if (root === null) return doc.querySelector(OPEN_DIALOG) !== null
  for (const child of doc.body.children) {
    if (child === root) continue
    if (child.matches(OPEN_DIALOG) || child.querySelector(OPEN_DIALOG) !== null) return true
  }
  return false
}

/** 可能多报，不会漏报。返回停止函数。 */
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
    observer.observe(doc.body, { childList: true })
    for (const child of doc.body.children) watch(child)
  }
  return () => observer.disconnect()
}
