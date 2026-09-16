import { Switch as BaseSwitch } from '@base-ui/react/switch'
import type { ComponentProps } from 'react'
import { cn } from '../class-names'

export type SwitchSize = 'sm' | 'md'

export type SwitchProps = ComponentProps<typeof BaseSwitch.Root> & {
  /** sm 用于设置页这类密集列表，md 为默认尺寸。 */
  readonly size?: SwitchSize
}

/*
 * 轨道与滑块必须成对定义：行程 = 轨道宽 - 滑块宽 - 两侧留白。
 *
 * 拆开写、或者由使用方用 CSS 只压轨道，滑块就会停在轨道外面。
 * 所以尺寸只有这一张表，使用方通过 size 选择，不通过样式覆盖。
 */
const ROOT_SIZE: Record<SwitchSize, string> = {
  sm: 'h-[18px] w-[32px]',
  md: 'h-[24px] w-[42px]',
}

const THUMB_SIZE: Record<SwitchSize, string> = {
  sm: 'size-[14px] data-[unchecked]:translate-x-[2px] data-[checked]:translate-x-[16px]',
  md: 'size-[18px] data-[unchecked]:translate-x-[3px] data-[checked]:translate-x-[21px]',
}

/**
 * Poietica compact switch.
 *
 * Base UI owns interaction semantics and keyboard behavior.
 * The design system owns sizing, motion, focus and visual states.
 */
export function Switch({ className, children, size = 'md', ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root
      className={cn(
        'group relative inline-flex',
        'shrink-0',
        ROOT_SIZE[size],
        'cursor-pointer items-center',
        'rounded-full border',
        'border-transparent',
        'bg-input/70',
        'outline-none',
        'transition-colors',
        'duration-[var(--ui-duration-fast)]',
        'ease-[var(--ui-ease-standard)]',

        'after:absolute',
        'after:-inset-[10px]',
        'after:content-[""]',

        'hover:bg-input',
        'focus-visible:ring-2',
        'focus-visible:ring-ring/40',

        'disabled:cursor-not-allowed',
        'disabled:opacity-45',

        /* 开启态这支亮蓝与主色（更深、偏紫）不是一支，只服务开关，写字面值。 */
        'data-[checked]:bg-[#339cff]',
        'data-[unchecked]:bg-input/70',

        'motion-reduce:transition-none',
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          'pointer-events-none block',
          THUMB_SIZE[size],
          'rounded-full',
          'bg-background',

          'transition-transform',
          'duration-[var(--ui-duration-fast)]',
          'ease-[var(--ui-ease-emphasized)]',

          'motion-reduce:transition-none',
        )}
      />

      {children}
    </BaseSwitch.Root>
  )
}
