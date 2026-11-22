import type { ComponentPropsWithRef } from 'react'
import { cn } from '../class-names'

/*
 * 复选框。走原生控件与 `accent-color`：不另画一套勾选图形，平台/高对比模式下的
 * 键盘与读屏行为都由浏览器负责。尺寸只给默认的 size-4，调用方可覆盖。
 */
export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {}

function Checkbox({ className, ...props }: CheckboxProps) {
  return <input className={cn('size-4 shrink-0 accent-primary', className)} type="checkbox" {...props} />
}

export { Checkbox }
