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
  readonly value: TValue
}

/* 原生单选钮打底（方向键、label 点击都归浏览器），滑块位置由 index/count 算出。 */
export function SegmentedControl<TValue extends string>({
  className,
  label,
  name,
  onValueChange,
  options,
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
    <div aria-label={label} className={cn('segmented-control', className)} role="radiogroup">
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
