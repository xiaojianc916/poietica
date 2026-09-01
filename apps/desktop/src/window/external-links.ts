import { openBrowserUrlExternally } from '@poietica/native-bridge'

/**
 * 外链归系统浏览器。
 *
 * 主窗口是 decorations: false —— 没有地址栏，没有后退。webview 一旦导航到外站，
 * 应用就被那张网页替换掉，且没有任何回来的路径。在此之前，AI 回答里的每一个引用
 * 链接、设置页里的每一个 apiKeysUrl，点下去都是这个结果。
 *
 * 用委托而不是逐个组件接管：链接的来源太多（Streamdown 正文、设置页、错误面板），
 * 逐处接管既漏又要各自复制一遍判断。capture 阶段一个监听，谁也漏不掉，而且没有
 * 任何组件需要知道它的存在 —— Streamdown 自带的 link-safety 确认框也因此被关掉
 * （见 agent-ui 的 timeline/Prose.tsx）：一条已经被接管的路径上不该再有确认框。
 */

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/*
 * 左键与中键都算，修饰键不改变归属。
 *
 * 此前这里只认「左键裸点击」，理由写的是「中键、Ctrl/Cmd 点击在桌面语义里本来
 * 就是另开」—— 但被放过的那一次点击并没有被交给系统浏览器，它落回 webview 的
 * 默认导航。主窗口是 decorations: false，没有地址栏也没有后退：Ctrl+点一个引用
 * 链接，应用当场变成一张回不来的网页。
 *
 * 右键不在其中 —— 那是上下文菜单，不是打开。
 */
function isOpenIntent(event: MouseEvent): boolean {
  return !event.defaultPrevented && (event.button === 0 || event.button === 1)
}

function externalHrefOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null
  }

  const anchor = target.closest('a[href]')

  if (!(anchor instanceof HTMLAnchorElement)) {
    return null
  }

  /*
   * 走 anchor.href 而不是 getAttribute('href')：前者已经由引擎解析成绝对 URL，
   * 相对路径、协议相对路径、`#` 锚点的差别在这里已经被抹平。
   */
  let url: URL

  try {
    url = new URL(anchor.href, document.baseURI)
  } catch {
    return null
  }

  return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null
}

export function installExternalLinks(): () => void {
  const onActivate = (event: MouseEvent): void => {
    if (!isOpenIntent(event)) {
      return
    }

    const href = externalHrefOf(event.target)

    if (href === null) {
      return
    }

    /*
     * 一个外链只有一个去处，所以这一跳到此为止：preventDefault 挡住 webview 的
     * 默认导航，stopPropagation 挡住任何还想为同一次点击再要一次确认的组件。
     */
    event.preventDefault()
    event.stopPropagation()

    void openBrowserUrlExternally(href).catch((cause: unknown) => {
      console.error('[Poietica] Failed to open an external link', cause)
    })
  }

  /* 中键不派发 click，只派发 auxclick（UI Events 规范）。两个入口，一条路径。 */
  document.addEventListener('click', onActivate, { capture: true })
  document.addEventListener('auxclick', onActivate, { capture: true })

  return () => {
    document.removeEventListener('click', onActivate, { capture: true })
    document.removeEventListener('auxclick', onActivate, { capture: true })
  }
}
