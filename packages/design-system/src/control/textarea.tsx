import type { ComponentPropsWithRef } from 'react'
import { cn } from '../class-names'

/*
 * 多行输入。与 Input 共用 `.settings-input` 词汇；高度交给 rows / className，
 * 不在原语里写死行高。
 */
export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  readonly variant?: 'default' | 'bare' | null | undefined
}

function Textarea({ className, variant, ...props }: TextareaProps) {
  return <textarea className={cn(variant === 'bare' ? undefined : 'settings-input', className)} {...props} />
}

export { Textarea }
