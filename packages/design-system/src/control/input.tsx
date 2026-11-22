import type { ComponentPropsWithRef } from 'react'
import { cn } from '../class-names'

/*
 * 表单输入。默认落 `.settings-input` 这一族——全仓设置表单已经在用的输入词汇
 * （框色、占位符、焦点环、禁用态都在 settings.css 里）。需要功能自己的外观时用
 * `variant="bare"`，className 仍可叠加布局。
 *
 * 不在这里写尺寸档：现有输入的高度由设置行、工具条、编辑器各自决定，硬套一档会改视觉。
 */
export interface InputProps extends ComponentPropsWithRef<'input'> {
  readonly variant?: 'default' | 'bare' | null | undefined
}

function Input({ className, variant, ...props }: InputProps) {
  return <input className={cn(variant === 'bare' ? undefined : 'settings-input', className)} {...props} />
}

export { Input }
