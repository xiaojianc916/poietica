import '../app.css'

import {
  type BrowserHostView,
  type BrowserPopupRequest,
  BrowserPopupSurface,
} from '@poietica/browser'
import { warn } from '@poietica/core'
import { readBrowserPopup } from '@poietica/ipc'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { browserHostPort } from './browser-host-port'

function closePopup(): void {
  void browserHostPort.closePopup().catch((cause: unknown) => {
    warn('浏览器浮层无法关闭', { scope: 'browser-popup', cause })
  })
}

function PopupWindow() {
  const [host, setHost] = useState<BrowserHostView | null>(null)
  const [request, setRequest] = useState<BrowserPopupRequest | null>(null)

  useEffect(() => {
    let release: (() => void) | null = null
    let dropped = false

    void (async () => {
      try {
        const stop = await browserHostPort.watch((state) => {
          if (!dropped) {
            setHost(state)
          }
        })
        if (dropped) {
          stop()
          return
        }

        release = stop
        const next = await readBrowserPopup()
        if (dropped) {
          return
        }
        if (next === null) {
          closePopup()
          return
        }
        document.documentElement.dataset['theme'] = next.theme
        setRequest(next)
      } catch (cause) {
        warn('浏览器浮层没有拿到初始化快照', { scope: 'browser-popup', cause })
        closePopup()
      }
    })()

    return () => {
      dropped = true
      release?.()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePopup()
      }
    }
    const onBlur = () => closePopup()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  if (host === null || request === null) {
    return null
  }

  return (
    <div className="h-full p-2">
      <BrowserPopupSurface
        host={host}
        onAction={browserHostPort.dispatchPopupAction}
        onDismiss={closePopup}
        port={browserHostPort}
        request={request}
      />
    </div>
  )
}

const container = document.getElementById('popup')
if (container === null) {
  throw new Error('Browser popup document is missing its mount point.')
}

createRoot(container).render(<PopupWindow />)
