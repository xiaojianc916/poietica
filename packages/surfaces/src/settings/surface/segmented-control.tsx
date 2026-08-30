/*
 * 分段控件：一条轨上并排几档，选中的那一档下面有一个会滑过去的方块。
 *
 * 底下是原生单选钮，不是两个按钮。单选就是 radio —— 同名一组里方向键切换、
 * aria-checked、组语义、可聚焦性都是平台给的；用按钮拼一个再补 roving tabindex，
 * 是把浏览器已经做完的事重做一遍，而且通常只做对一半。
 *
 * 单选钮盖住整格但不显形（appearance: none + 铺满），所以点标签哪里都算点这一档，
 * 键盘焦点环画在标签上。
 *
 * 滑块的位置由内联样式给：只有这里知道一共几档、现在是第几档。百分比落在同一个
 * 盒子上 —— 轨道是 grid_auto-columns: 1fr，每档等宽，所以「第 index 档」就是
 * index / count 的位置，没有需要对齐的余量。
 */

export interface SegmentedOption<TValue extends string = string> {
  readonly value: TValue
  readonly label: string
}

export interface SegmentedControlProps<TValue extends string> {
  /** 读给辅助技术听的组名。屏幕上的标签由所在的设置行给。 */
  readonly label: string
  /** 单选钮的组名，同一页里不能重名。 */
  readonly name: string
  readonly options: readonly SegmentedOption<TValue>[]
  readonly value: TValue
  readonly onValueChange: (value: TValue) => void
}

export function SegmentedControl<TValue extends string>({
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

  return (
    <div aria-label={label} className="settings-segmented" role="radiogroup">
      <span
        className="settings-segmented__thumb"
        style={{
          inlineSize: `${100 / options.length}%`,
          insetInlineStart: `${(index * 100) / options.length}%`,
        }}
      />

      {options.map((option) => (
        <label className="settings-segmented__option" key={option.value}>
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
