import type { ComponentPropsWithRef } from 'react'
import { cn } from './class-names'

/*
 * 变体表。不出这个文件：它是 Button 表达自己的方式，不是供人拼 class 的公共资产。
 * 写法与同目录其余组件一致（switch.tsx 的 ROOT_SIZE / THUMB_SIZE）。
 */

const BASE =
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

export type ButtonVariant =
  | 'default'
  | 'destructive'
  | 'outline'
  | 'secondary'
  | 'soft'
  | 'ghost'
  | 'link'

export type ButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'icon'

const VARIANT: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
  destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
  outline:
    'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
  /* soft：无边框无投影，填充跟着 divider token 走，所以它和分割线永远同一个灰阶。 */
  soft: 'bg-divider text-foreground hover:bg-divider/70',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  link: 'text-primary underline-offset-4 hover:underline',
}

const SIZE: Record<ButtonSize, string> = {
  default: 'h-[var(--ui-control-height-md)] px-4 py-2',
  /* xs 与开关、下拉触发器同档（26px）：一行设置里不该出现三种控件高度。 */
  xs: 'h-[26px] rounded-lg px-2.5 text-xs',
  sm: 'h-[var(--ui-control-height-sm)] rounded-md px-3 text-xs',
  lg: 'h-[var(--ui-control-height-lg)] rounded-md px-8',
  icon: 'h-[var(--ui-control-height-md)] w-[var(--ui-control-height-md)]',
}

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  readonly variant?: ButtonVariant | null | undefined
  readonly size?: ButtonSize | null | undefined
}

function Button({ className, size, variant, ...props }: ButtonProps) {
  return (
    <button
      className={cn(BASE, VARIANT[variant ?? 'default'], SIZE[size ?? 'default'], className)}
      {...props}
    />
  )
}

export { Button }
