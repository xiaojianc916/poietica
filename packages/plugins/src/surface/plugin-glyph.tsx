/* Managed by root refactor.mjs. */

import { cn } from '@poietica/ui'
import { useState } from 'react'

import { pluginIconFor } from './plugin-icons'

/**
 * 插件、技能与 MCP 的图形标识。
 *
 * 已知条目使用随应用打包的本地 SVG；没有网络请求，也不放宽 Tauri 的 img-src。
 * marketplace 与 agent 报来的未知条目继续使用稳定的彩色首字母。即使本地资源在
 * 开发构建中损坏，img 的错误分支也会退回首字母，而不是留下碎图。
 */

const SIZES = {
  sm: {
    frame: 'size-8 rounded-lg text-[11px]',
    image: 'size-[18px]',
  },
  md: {
    frame: 'size-10 rounded-[10px] text-xs',
    image: 'size-6',
  },
  lg: {
    frame: 'size-16 rounded-2xl text-lg',
    image: 'size-9',
  },
} as const

export type PluginGlyphSize = keyof typeof SIZES

/*
 * 兜底色相由 id 派生，不由显示名派生：显示名会改，id 是插件目录名或能力号。
 * 图标已知时使用图标自己的背景；未知时仍保持原有的确定性配色。
 */
export function pluginHue(id: string): number {
  let hash = 7

  for (const character of id) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360
  }

  return hash
}

function initialsOf(displayName: string): string {
  const words = displayName.split(/[\s_-]+/u).filter((word) => word !== '')
  const initials = words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toUpperCase()

  return initials === '' ? '?' : initials
}

export interface PluginGlyphProps {
  readonly displayName: string
  readonly id: string
  readonly size: PluginGlyphSize
}

export function PluginGlyph({ displayName, id, size }: PluginGlyphProps) {
  const [failedSource, setFailedSource] = useState<string | undefined>()
  const icon = pluginIconFor(id, displayName)
  const renderedIcon = icon !== undefined && icon.src !== failedSource ? icon : undefined

  const hue = pluginHue(id)
  const dimensions = SIZES[size]
  const backgroundColor = renderedIcon?.background ?? 'oklch(0.94 0.045 ' + hue + ')'
  const foregroundColor = 'oklch(0.46 0.13 ' + hue + ')'

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold',
        dimensions.frame,
      )}
      style={{
        backgroundColor,
        color: foregroundColor,
      }}
    >
      {renderedIcon === undefined ? (
        initialsOf(displayName)
      ) : (
        <img
          alt=""
          className={cn('pointer-events-none object-contain', dimensions.image)}
          decoding="async"
          draggable={false}
          onError={() => setFailedSource(renderedIcon.src)}
          src={renderedIcon.src}
        />
      )}
    </span>
  )
}
