import { openBrowserUrlExternally } from '@poietica/native-bridge/browser'

/* 外链归系统浏览器：主窗口没有地址栏与后退，webview 一旦导航到外站就回不来。 */

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

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

  /* 用 anchor.href 而非 getAttribute('href')：引擎已把前者解析成绝对 URL。 */
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

    event.preventDefault()
    event.stopPropagation()

    void openBrowserUrlExternally(href).catch((cause: unknown) => {
      console.error('[Poietica] Failed to open an external link', cause)
    })
  }

  /* 中键不派发 click，只派发 auxclick（UI Events 规范）。 */
  document.addEventListener('click', onActivate, { capture: true })
  document.addEventListener('auxclick', onActivate, { capture: true })

  return () => {
    document.removeEventListener('click', onActivate, { capture: true })
    document.removeEventListener('auxclick', onActivate, { capture: true })
  }
}
