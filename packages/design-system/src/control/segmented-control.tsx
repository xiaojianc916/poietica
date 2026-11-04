import type { CSSProperties } from 'react'
import { cn } from '../class-names'
import './segmented-control.css'

export interface SegmentedOption<TValue extends string = string> {
  readonly value: TValue
  readonly label: string
}

export interface SegmentedControlProps<TValue extends string> {
  readonly className?: string
  readonly label: string
  readonly name: string
  readonly onValueChange: (value: TValue) => void
  readonly options: readonly SegmentedOption<TValue>[]
  /**
   * 深色下的一组抬升取值。默认档落在卡面 #232323 上；`raised` 把轨道与滑块各抬一档，
   * 给页面底色比卡面更亮、需要一层分档的表单用。浅色不变。
   */
  readonly tone?: 'default' | 'raised'
  readonly value: TValue
}

/* 原生单选钮打底（方向键、label 点击都归浏览器），滑块位置由 index/count 算出。 */
export function SegmentedControl<TValue extends string>({
  className,
  label,
  name,
  onValueChange,
  options,
  tone,
  value,
}: SegmentedControlProps<TValue>) {
  const index = Math.max(
    options.findIndex((option) => option.value === value),
    0,
  )
  const share = 100 / options.length
  const thumbStyle: CSSProperties = {
    inlineSize: `${String(share)}%`,
    insetInlineStart: `${String(index * share)}%`,
  }

  return (
    <div
      aria-label={label}
      className={cn('segmented-control', className)}
      data-tone={tone === 'raised' ? 'raised' : undefined}
      role="radiogroup"
    >
      <span className="segmented-control__thumb" style={thumbStyle} />

      {options.map((option) => (
        <label className="segmented-control__option" key={option.value}>
          <input
            checked={option.value === value}
            name={name}
            onChange={() => onValueChange(option.value)}
            type="radio"
            value={option.value}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}
