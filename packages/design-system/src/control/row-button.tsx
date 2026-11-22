import type { ComponentPropsWithRef } from 'react'

/*
 * 无外观的行/卡点击按钮。
 *
 * 它不带任何外观，也不做样式重置：整行、整卡的点击面本来就由所在功能决定长相，
 * 硬给一套 reset 会改掉现有渲染。这里只固定两件事——默认 `type="button"`（避免在
 * 表单里意外提交），以及 `data-slot` 作为「功能不再直接写 <button>」的落点。
 * 需要外观时由调用方的 className / CSS 负责。
 */
export type RowButtonProps = ComponentPropsWithRef<'button'>

function RowButton({ className, type = 'button', ...props }: RowButtonProps) {
  return <button className={className} data-slot="row-button" type={type} {...props} />
}

export { RowButton }
