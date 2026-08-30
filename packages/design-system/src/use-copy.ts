import { useCallback, useEffect, useRef, useState } from 'react'

/*
 * 复制一段文本，并且让人看见它到手了。
 *
 * 对勾停留 2.2 秒：够看清，又短于一次「我再复制一遍」的犹豫。
 *
 * 失败不切对勾。一个假的成功反馈比没有反馈更贵：人会以为东西已经在剪贴板里，
 * 于是把源头关掉。
 */
const RESTORE_MS = 2200

export interface CopyAction {
  readonly copied: boolean
  readonly copy: () => void
}

export function useCopy(text: string): CopyAction {
  const [copied, setCopied] = useState(false)
  const restore = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /* 卸载时收掉定时器：被复制的那段内容常在这之前就从流里消失了。 */
  useEffect(
    () => () => {
      clearTimeout(restore.current)
    },
    [],
  )

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        clearTimeout(restore.current)
        setCopied(true)

        restore.current = setTimeout(() => setCopied(false), RESTORE_MS)
      })
      .catch((cause: unknown) => {
        console.error('[Poietica] Clipboard write failed', cause)
      })
  }, [text])

  return { copied, copy }
}
