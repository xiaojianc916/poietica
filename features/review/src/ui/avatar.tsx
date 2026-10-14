import { cn } from '@poietica/design-system'
import { type ReactNode, useState } from 'react'

/*
 * 作者头像：GitHub 给了图就画图，没给（或图加载失败）就退回首字母圆牌。
 *
 * 为什么不用 login 拼 `avatars.githubusercontent.com/<login>`：login 也可能是团队 slug，拼出来的
 * 很可能是另一个人的脸。只画 GitHub 明确挂在这个 actor 上的 avatarUrl。
 *
 * 尺寸表与 synara 同档：sm 是列表行与详情头（16px），md 是评论卡（20px）。
 */

const SIZE_CLASS = {
  sm: 'size-4 text-[8px]',
  md: 'size-5 text-[10px]',
  lg: 'size-7 text-xs',
} as const

export interface AvatarProps {
  readonly login: string
  readonly url: string | null
  readonly size?: keyof typeof SIZE_CLASS
  readonly className?: string
}

export function Avatar({ login, url, size = 'sm', className }: AvatarProps): ReactNode {
  const [broken, setBroken] = useState<string | null>(null)
  const shell = cn(SIZE_CLASS[size], 'shrink-0 rounded-full ring-1 ring-border/50', className)
  if (url !== null && url !== broken) {
    return (
      <img
        alt=""
        className={cn(shell, 'object-cover')}
        decoding="async"
        draggable={false}
        loading="lazy"
        onError={() => {
          setBroken(url)
        }}
        src={url}
      />
    )
  }
  return (
    <span aria-hidden className={cn(shell, 'grid place-items-center bg-muted font-medium text-muted-foreground')}>
      {(login.trim().slice(0, 1) || '?').toUpperCase()}
    </span>
  )
}
