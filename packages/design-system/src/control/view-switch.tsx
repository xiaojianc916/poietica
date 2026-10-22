import { cn } from '../class-names'
import './view-switch.css'

export interface ViewSwitchOption<TValue extends string = string> {
  readonly value: TValue
  readonly label: string
}

export interface ViewSwitchProps<TValue extends string> {
  readonly className?: string
  /** 整组的无障碍名称（「查看方式」）。 */
  readonly label: string
  readonly onValueChange: (value: TValue) => void
  readonly options: readonly ViewSwitchOption<TValue>[]
  readonly value: TValue
}

/*
 * 查看方式切换（Preview / Source 这种两三档）：贴在一条窄工具条里，所以比设置页的 SegmentedControl 小一号、不带滑动的滑块。
 * 原是技能文档面板私有的那一组（skill-doc__modes，照 legacy 宿主），右坞的文件查看器也要同一个样子，于是下沉到这里。
 * 每档是一个 aria-pressed 按钮：两档之间是「这一面 / 那一面」的切换，不是表单里的单选。
 */
export function ViewSwitch<TValue extends string>({
  className,
  label,
  onValueChange,
  options,
  value,
}: ViewSwitchProps<TValue>) {
  return (
    <fieldset aria-label={label} className={cn('view-switch', className)}>
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className="view-switch__option"
          key={option.value}
          onClick={() => {
            onValueChange(option.value)
          }}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}
