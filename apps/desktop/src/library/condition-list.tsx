import {
  cn,
  popupPositionerClassName,
  popupSurfaceClassName,
  type SelectOption,
} from '@poietica/design-system'
import type { Field, FieldKind, Test, TintColor } from '@poietica/library'
import {
  ALargeSmall,
  CalendarDays,
  ChevronDown,
  CircleDot,
  CircleMinus,
  CirclePlus,
  GripVertical,
  Hash,
  Image,
  JapaneseYen,
  Link,
  List,
  type LucideIcon,
  Mail,
  Paperclip,
  Phone,
  SquareCheck,
  User,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 字段图标的唯一产地：列头、字段管理与判据下拉都认这一张表。 */
export const KIND_MARK: Record<FieldKind, LucideIcon> = {
  text: ALargeSmall,
  number: Hash,
  currency: JapaneseYen,
  select: CircleDot,
  multiSelect: List,
  date: CalendarDays,
  person: User,
  checkbox: SquareCheck,
  link: Link,
  email: Mail,
  phone: Phone,
  image: Image,
  attachment: Paperclip,
}

export const KIND_LABEL: Record<FieldKind, string> = {
  text: '文本',
  number: '数字',
  currency: '货币',
  select: '单选',
  multiSelect: '多选',
  date: '日期',
  person: '人员',
  checkbox: '复选框',
  link: '链接',
  email: '邮箱',
  phone: '电话',
  image: '图片',
  attachment: '附件',
}

/** 类型下拉的顺序，加一种类型往末尾加。 */
export const KIND_ORDER: readonly FieldKind[] = [
  'text',
  'number',
  'currency',
  'select',
  'multiSelect',
  'date',
  'person',
  'checkbox',
  'link',
  'email',
  'phone',
  'image',
  'attachment',
]

const TEST_LABEL: Record<Test, string> = {
  any: '所有内容',
  filled: '不为空',
  empty: '为空',
  contains: '包含',
  equals: '等于',
  notEquals: '不等于',
  greater: '大于',
  greaterEquals: '大于等于',
  less: '小于',
  lessEquals: '小于等于',
}

const TEXT_TESTS: readonly Test[] = ['contains', 'equals', 'notEquals', 'empty', 'filled']
const CHOICE_TESTS: readonly Test[] = ['equals', 'notEquals', 'empty', 'filled']
const ORDERED_TESTS: readonly Test[] = [
  'equals',
  'notEquals',
  'greater',
  'greaterEquals',
  'less',
  'lessEquals',
  'empty',
  'filled',
]

const TESTS: Record<FieldKind, readonly Test[]> = {
  text: TEXT_TESTS,
  number: ORDERED_TESTS,
  currency: ORDERED_TESTS,
  select: CHOICE_TESTS,
  multiSelect: CHOICE_TESTS,
  date: ORDERED_TESTS,
  person: TEXT_TESTS,
  checkbox: TEXT_TESTS,
  link: TEXT_TESTS,
  email: TEXT_TESTS,
  phone: TEXT_TESTS,
  image: TEXT_TESTS,
  attachment: TEXT_TESTS,
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
  return (
    test === 'contains' ||
    test === 'equals' ||
    test === 'notEquals' ||
    test === 'greater' ||
    test === 'greaterEquals' ||
    test === 'less' ||
    test === 'lessEquals'
  )
}

/** 判据换位：起止有一个对不上就原样返回，拖拽手势不该炸掉列表。 */
export function moveCondition<T extends { readonly id: string }>(
  rows: readonly T[],
  from: string,
  to: string,
): T[] {
  const a = rows.findIndex((row) => row.id === from)
  const b = rows.findIndex((row) => row.id === to)

  if (a < 0 || b < 0 || a === b) {
    return [...rows]
  }

  const next = [...rows]
  const [taken] = next.splice(a, 1)

  if (taken === undefined) {
    return next
  }

  next.splice(b, 0, taken)

  return next
}

export interface PickerOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly mark?: LucideIcon
}

/**
 * 判据行里的下拉：圆角框 + 悬浮列表。不用设计系统的 Select，
 * 它是单根浮层，嵌进面板的浮层里点选会把整张面板一起关掉。
 * 列表挂到 body 上：面板浮层自带位移与裁剪，寄生在里面量不准位置。
 */
export function Picker<const T extends string>({
  onSelect,
  options,
  value,
}: {
  onSelect: (value: T) => void
  options: readonly PickerOption<T>[]
  value: T
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{
    above: boolean
    anchorTop: number
    left: number
    top: number
    width: number
  } | null>(null)
  const current = options.find((option) => option.value === value)
  const Mark = current?.mark

  useEffect(() => {
    if (!open) {
      return
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAt(null)
        setOpen(false)
      }
    }
    const onPointer = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        (trigger.current?.contains(event.target) ?? false) === false &&
        (list.current?.contains(event.target) ?? false) === false
      ) {
        setAt(null)
        setOpen(false)
      }
    }
    const onScroll = (): void => {
      setAt(null)
      setOpen(false)
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  /* 列表先长在触发器下方，装好后超出视口才翻上去，只翻一次。 */
  useEffect(() => {
    const node = list.current

    if (!open || at === null || at.above || node === null) {
      return
    }

    const rect = node.getBoundingClientRect()

    if (rect.bottom > window.innerHeight - 8) {
      setAt({ ...at, above: true, top: Math.max(8, at.anchorTop - rect.height - 4) })
    }
  }, [open, at])

  return (
    <div className="min-w-0 flex-1">
      <button
        className="flex h-9 w-full items-center gap-2 rounded-xl border border-input bg-background px-3 text-left text-sm hover:bg-accent/50"
        onClick={() => {
          if (open) {
            setAt(null)
            setOpen(false)

            return
          }

          const rect = trigger.current?.getBoundingClientRect()

          if (rect === undefined) {
            return
          }

          setAt({
            above: false,
            anchorTop: rect.top,
            left: rect.left,
            top: rect.bottom + 4,
            width: rect.width,
          })
          setOpen(true)
        }}
        ref={trigger}
        type="button"
      >
        {Mark === undefined ? null : (
          <Mark aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ''}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && at !== null
        ? createPortal(
            <div
              className={cn(popupSurfaceClassName, popupPositionerClassName, 'fixed p-1.5')}
              ref={list}
              style={{ left: at.left, top: at.top, width: Math.max(at.width, 120) }}
            >
              <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                {options.map((option) => {
                  const OptionMark = option.mark

                  return (
                    <li key={option.value}>
                      <button
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent"
                        onClick={() => {
                          onSelect(option.value)
                          setAt(null)
                          setOpen(false)
                        }}
                        type="button"
                      >
                        {OptionMark === undefined ? null : (
                          <OptionMark
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

/** 筛选、分组、排序、填色共用的外壳：标题、判据列表、左下添加。 */
export function ConditionPanel({
  addLabel,
  children,
  count,
  empty,
  onAdd,
  onClose,
  title,
}: {
  addLabel: string
  children: ReactNode
  count: number
  empty: string
  onAdd: () => void
  onClose: () => void
  title: string
}) {
  return (
    <div className="flex w-[30rem] flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-base">{title}</span>
        <button
          aria-label={`关闭${title}`}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {count === 0 ? (
        <p className="py-8 text-center text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">{children}</ul>
      )}
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent"
        onClick={onAdd}
        type="button"
      >
        <CirclePlus aria-hidden="true" className="size-5 shrink-0" />
        {addLabel}
      </button>
    </div>
  )
}

/** 一条判据的排布只有这一种：拖动 → 字段 → 本类特有的控件 → 移除。 */
export function ConditionRow({
  children,
  field,
  fields,
  id,
  onField,
  onMove,
  onRemove,
}: {
  children?: ReactNode
  field: number
  fields: readonly Field[]
  id: string
  onField: (field: number) => void
  onMove: (from: string, to: string) => void
  onRemove: () => void
}) {
  return (
    <li
      className="flex items-center gap-2"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        onMove(event.dataTransfer.getData('text/plain'), id)
      }}
    >
      <button
        aria-label="拖动排序"
        className="shrink-0 cursor-grab text-muted-foreground"
        draggable
        onDragStart={(event) => event.dataTransfer.setData('text/plain', id)}
        type="button"
      >
        <GripVertical aria-hidden="true" className="size-4" />
      </button>
      <Picker
        onSelect={(value) => onField(Number(value))}
        options={fields.map((item, index) => ({
          value: String(index),
          label: item.name,
          mark: KIND_MARK[item.kind],
        }))}
        value={String(field)}
      />
      {children}
      <button
        aria-label="移除这一条"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={onRemove}
        type="button"
      >
        <CircleMinus aria-hidden="true" className="size-5" />
      </button>
    </li>
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
