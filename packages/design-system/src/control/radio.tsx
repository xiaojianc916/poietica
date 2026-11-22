import type { ComponentPropsWithRef } from 'react'
import { cn } from '../class-names'

/*
 * 单选框。与 Checkbox 同一个口径：原生控件 + accent-color，不重画图形。
 * 表单里的「多档单选」优先用 SegmentedControl；这里只服务真正的 radio 列表。
 */
export interface RadioProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {}

function Radio({ className, ...props }: RadioProps) {
  return <input className={cn('size-4 shrink-0 accent-primary', className)} type="radio" {...props} />
}

export { Radio }
