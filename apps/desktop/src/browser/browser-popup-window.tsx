import '../app.css'

import { type BrowserHostView, type BrowserPopupKind, BrowserPopupSurface } from '@poietica/browser'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { browserHostPort } from './browser-runtime'

/*
 * 浮层窗口的入口。
 *
 * 第二个文档不是第二份状态：标签快照仍来自宿主那条全量广播，动作仍走同一批命令。
 * 主题是已解析值，随开窗参数带过来 —— 这个文档没有设置流，不自己再解析一次。
 */

const parameters = new URLSearchParams(window.location.search)
const requestedKind = parameters.get('kind')
const requestedTheme = parameters.get('theme')

function PopupWindow({ kind }: { readonly kind: BrowserPopupKind }) {
  const [host, setHost] = useState<BrowserHostView | null>(null)

  useEffect(() => {
    let release: (() => void) | null = null
    let dropped = false

    void browserHostPort.watch(setHost).then((stop) => {
      if (dropped) {
        stop()
      } else {
        release = stop
      }
    })

    return () => {
      dropped = true
      release?.()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void browserHostPort.closePopup()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  if (host === null) {
    return null
  }

  return (
    <BrowserPopupSurface
      host={host}
      kind={kind}
      onDismiss={() => {
        void browserHostPort.closePopup()
      }}
      port={browserHostPort}
    />
  )
}

function mount(): void {
  const container = document.getElementById('popup')

  if (container === null) {
    throw new Error('Browser popup document is missing its mount point.')
  }

  if (requestedKind !== 'overflow' && requestedKind !== 'tabs') {
    throw new Error('Browser popup was opened without a known surface kind.')
  }

  if (requestedTheme !== null) {
    document.documentElement.dataset['theme'] = requestedTheme
  }

  createRoot(container).render(<PopupWindow kind={requestedKind} />)
}

mount()
