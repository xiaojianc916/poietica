import { Button } from '@poietica/design-system'
import { type ReactElement, useEffect, useState } from 'react'
import type { ModelsApi } from './api'

/*
 * 未配置服务商的横幅（07 页 §6E）。没有首启引导（用户确认过）：只显示一条横幅 + 「去设置」。
 *
 * 外壳（workbench 的 BannerHost）负责语气色与容器，这里只出内容。
 */

/** 「一个已配置的服务商都没有」。目录为空也算没有（还没读到目录时返回 false，不闪） */
export function isUnconfigured(providers: readonly { readonly configured: boolean }[]): boolean {
  return providers.length > 0 && !providers.some((p) => p.configured)
}

export function ModelsBanner({
  api,
  onGoToSettings,
}: {
  readonly api: ModelsApi
  readonly onGoToSettings: () => void
}): ReactElement | null {
  const [show, setShow] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void api
        .providers()
        .then((providers) => {
          if (!cancelled) setShow(isUnconfigured(providers))
        })
        .catch(() => undefined)
    }
    load()
    const sub = api.onChanged(load)
    return () => {
      cancelled = true
      sub.dispose()
    }
  }, [api])

  if (!show) return null
  return (
    <span className="models-banner">
      <span className="models-banner__text">还没有配置任何模型服务商</span>
      <Button onClick={onGoToSettings} size="xs" variant="soft">
        去设置
      </Button>
    </span>
  )
}

/**
 * EntryNoticeItem.useVisible 是一个 Hook（06 页 §5.5）。这里与组件读同一份状态：
 * 只有「读到目录且一个都没有配置」才占位。
 */
export function useUnconfiguredVisible(api: ModelsApi): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void api
        .providers()
        .then((providers) => {
          if (!cancelled) setVisible(isUnconfigured(providers))
        })
        .catch(() => undefined)
    }
    load()
    const sub = api.onChanged(load)
    return () => {
      cancelled = true
      sub.dispose()
    }
  }, [api])
  return visible
}
