import { cn, integrationMarkFor } from '@poietica/design-system'
import { useState } from 'react'

/* 认不出的条目与坏掉的资源退回彩色首字母：一个稳定的名字比一个空盒子好认。 */

const SIZES = {
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

function pluginHue(id: string): number {
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
  const icon = integrationMarkFor(id, displayName)
  const renderedIcon = icon !== undefined && icon.src !== failedSource ? icon : undefined

  const hue = pluginHue(id)
  const dimensions = SIZES[size]
  const backgroundColor = renderedIcon?.background ?? `oklch(0.94 0.045 ${hue})`
  const foregroundColor = `oklch(0.46 0.13 ${hue})`

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
