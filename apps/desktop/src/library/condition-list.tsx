import { Button, cn, Select, type SelectOption } from '@poietica/design-system'
import type { Field, FieldKind, Test, TintColor } from '@poietica/library'
import { Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'

const TEST_LABEL: Record<Test, string> = {
  any: '所有内容',
  filled: '不为空',
  empty: '为空',
  contains: '包含',
  equals: '等于',
  greater: '大于',
  less: '小于',
}

const TESTS: Record<FieldKind, readonly Test[]> = {
  text: ['any', 'filled', 'empty', 'contains', 'equals'],
  select: ['any', 'filled', 'empty', 'equals'],
  number: ['any', 'filled', 'empty', 'equals', 'greater', 'less'],
  date: ['any', 'filled', 'empty', 'equals', 'greater', 'less'],
}

const TINT_ORDER: readonly TintColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'gray',
]

const TINT_LABEL: Record<TintColor, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
  gray: '灰',
}

export const TINT_CLASS: Record<TintColor, string> = {
  red: 'bg-red-500/15',
  orange: 'bg-orange-500/15',
  yellow: 'bg-yellow-500/15',
  green: 'bg-green-500/15',
  blue: 'bg-blue-500/15',
  purple: 'bg-purple-500/15',
  gray: 'bg-zinc-500/15',
}

/** 日期列的大小说的是先后，读法跟着列的类型走。 */
function label(kind: FieldKind, test: Test): string {
  if (kind === 'date' && test === 'greater') {
    return '晚于'
  }
  if (kind === 'date' && test === 'less') {
    return '早于'
  }

  return TEST_LABEL[test]
}

export function testOptions(kind: FieldKind): readonly SelectOption<Test>[] {
  return TESTS[kind].map((test) => ({ value: test, label: label(kind, test) }))
}

export function needsOperand(test: Test): boolean {
  return test === 'contains' || test === 'equals' || test === 'greater' || test === 'less'
}

/** 筛选、分组、排序、填色共用的外壳：空态、判据列表、添加按钮。 */
export function ConditionPanel({
  addLabel,
  children,
  count,
  empty,
  onAdd,
}: {
  addLabel: string
  children: ReactNode
  count: number
  empty: string
  onAdd: () => void
}) {
  return (
    <div className="flex w-80 flex-col gap-1">
      {count === 0 ? (
        <p className="px-2 py-3 text-center text-muted-foreground text-xs">{empty}</p>
      ) : (
        <div className="flex flex-col gap-1">{children}</div>
      )}
      <Button className="justify-start" onClick={onAdd} size="xs" variant="ghost">
        <Plus aria-hidden="true" className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  )
}

/** 一条判据的排布只有这一种：字段 → 本类特有的控件 → 移除。 */
export function ConditionRow({
  children,
  field,
  fields,
  onField,
  onRemove,
}: {
  children?: ReactNode
  field: number
  fields: readonly Field[]
  onField: (field: number) => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <Select
        className="min-w-20"
        data={fields.map((item, index) => ({ value: String(index), label: item.name }))}
        onValueChange={(value) => onField(Number(value))}
        type="字段"
        value={String(field)}
      />
      {children}
      <Button aria-label="移除这一条" onClick={onRemove} size="icon" variant="ghost">
        <Minus aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  )
}

export function TintPicker({
  color,
  onChange,
}: {
  color: TintColor
  onChange: (color: TintColor) => void
}) {
  return (
    <div className="flex items-center gap-0.5">
      {TINT_ORDER.map((option) => (
        <button
          aria-label={TINT_LABEL[option]}
          aria-pressed={option === color}
          className={cn(
            'size-4 rounded-full border border-divider',
            TINT_CLASS[option],
            option === color && 'ring-2 ring-primary',
          )}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        />
      ))}
    </div>
  )
}
