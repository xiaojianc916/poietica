import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  popupPositionerClassName,
  popupSurfaceClassName,
  Select,
  Switch,
} from '@poietica/design-system'
import {
  addField,
  addRow,
  duplicateField,
  duplicateRow,
  type Field,
  type FieldKind,
  fields,
  insertField,
  insertRows,
  type LibraryController,
  moveField,
  nextFieldName,
  options,
  project,
  type RowHeight,
  removeField,
  removeRow,
  renameField,
  type SheetRow,
  type SheetView,
  setCell,
  setKind,
  type TableSheet,
  tintOf,
} from '@poietica/library'
import {
  AlignJustify,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  CirclePlus,
  Copy,
  EyeOff,
  Filter,
  GripVertical,
  Layers,
  List,
  ListPlus,
  Lock,
  type LucideIcon,
  MoveHorizontal,
  Palette,
  Pencil,
  Plus,
  Redo,
  Search,
  Trash2,
  Undo,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConditionPanel,
  ConditionRow,
  KIND_LABEL,
  KIND_MARK,
  KIND_ORDER,
  moveCondition,
  needsOperand,
  Picker,
  TINT_CLASS,
  TintPicker,
  testOptions,
} from './condition-list'

const ROW_HEIGHT: Record<RowHeight, string> = {
  default: 'h-9',
  medium: 'h-12',
  relaxed: 'h-16',
  wide: 'h-20',
}

const HEIGHTS: readonly { value: RowHeight; label: string }[] = [
  { value: 'default', label: '默认' },
  { value: 'medium', label: '中等' },
  { value: 'relaxed', label: '宽松' },
  { value: 'wide', label: '超宽' },
]

const INPUT_TYPE: Record<FieldKind, 'text' | 'number' | 'date'> = {
  text: 'text',
  number: 'number',
  currency: 'number',
  select: 'text',
  multiSelect: 'text',
  date: 'date',
  person: 'text',
  checkbox: 'text',
  link: 'text',
  email: 'text',
  phone: 'text',
  image: 'text',
  attachment: 'text',
}

const STEP: Record<string, number> = { ArrowUp: -1, ArrowDown: 1 }

interface Shell {
  controller: LibraryController
  list: readonly Field[]
  sheet: TableSheet
  view: SheetView
}

function keyOf(index: number, name: string): string {
  return `${index}:${name}`
}

function kindAt(list: readonly Field[], field: number): FieldKind {
  return list[field]?.kind ?? 'text'
}

function update<T extends { readonly id: string }>(
  rows: readonly T[],
  id: string,
  change: Partial<T>,
): T[] {
  return rows.map((row) => (row.id === id ? { ...row, ...change } : row))
}

function drop<T extends { readonly id: string }>(rows: readonly T[], id: string): T[] {
  return rows.filter((row) => row.id !== id)
}

/** 工具条上的一个开关：图标、名字、条数徽标，打开后是它自己的面板。 */
function Panel({
  badge,
  children,
  label,
  mark: Mark,
  signal,
}: {
  badge: number
  children: (close: () => void) => ReactNode
  label: string
  mark: typeof Filter
  signal?: number
}) {
  const [open, setOpen] = useState(false)
  const lastSignal = useRef(signal)

  /* 列头菜单点名打开：计数变一次就开一次，平时不干预自己的开关。 */
  useEffect(() => {
    if (signal !== undefined && signal !== lastSignal.current) {
      lastSignal.current = signal
      setOpen(true)
    }
  }, [signal])

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm',
          badge === 0 ? 'hover:bg-accent' : 'bg-muted font-medium',
        )}
      >
        <Mark aria-hidden="true" className="size-3.5 text-muted-foreground" />
        {badge === 0 ? label : `${label} ${badge}`}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="p-4">
        {children(() => setOpen(false))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 单选列拿现有取值做下拉，其余列交给平台原生输入控件。 */
function Operand({
  choices,
  kind,
  onChange,
  value,
}: {
  choices: readonly string[]
  kind: FieldKind
  onChange: (value: string) => void
  value: string
}) {
  if ((kind === 'select' || kind === 'multiSelect') && choices.length > 0) {
    return (
      <Select
        className="min-w-20"
        data={choices.map((choice) => ({ value: choice, label: choice }))}
        onValueChange={onChange}
        type="取值"
        value={value}
      />
    )
  }

  return (
    <input
      aria-label="取值"
      className="h-7 min-w-0 flex-1 rounded-md bg-muted px-2 text-sm outline-none"
      onChange={(event) => onChange(event.target.value)}
      type={INPUT_TYPE[kind]}
      value={value}
    />
  )
}

function FieldsPanel({ controller, list, view }: Omit<Shell, 'sheet'>) {
  const [editing, setEditing] = useState<number | null>(null)

  return (
    <ul className="flex w-80 flex-col gap-0.5">
      {list.map((field, index) => {
        const Mark = KIND_MARK[field.kind]

        return (
          <li
            className="group flex h-8 items-center gap-1 rounded-md px-1 hover:bg-accent"
            key={keyOf(index, field.name)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()

              const from = Number(event.dataTransfer.getData('text/plain'))

              controller.reshape((sheet) => moveField(sheet, from, index))
            }}
          >
            <button
              aria-label="拖动或用上下方向键换位"
              className="cursor-grab text-muted-foreground"
              draggable
              onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))}
              onKeyDown={(event) => {
                const to = index + (STEP[event.key] ?? 0)

                if (to === index || to < 0 || to >= list.length) {
                  return
                }

                event.preventDefault()
                controller.reshape((sheet) => moveField(sheet, index, to))
              }}
              type="button"
            >
              <GripVertical aria-hidden="true" className="size-3.5" />
            </button>
            {editing === index ? (
              <form
                className="min-w-0 flex-1"
                onSubmit={(event) => {
                  event.preventDefault()

                  const value = new FormData(event.currentTarget).get('name')

                  setEditing(null)

                  if (typeof value === 'string' && value.trim().length > 0) {
                    controller.revise((sheet) => renameField(sheet, index, value.trim()))
                  }
                }}
              >
                <input
                  aria-label="字段名"
                  className="w-full rounded border border-input bg-background px-1 text-sm outline-none"
                  defaultValue={field.name}
                  name="name"
                  onBlur={() => setEditing(null)}
                  ref={(node) => {
                    node?.select()
                  }}
                />
              </form>
            ) : (
              <>
                <Mark aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{field.name}</span>
                <Button
                  aria-label="重命名字段"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => setEditing(index)}
                  size="icon"
                  variant="ghost"
                >
                  <Pencil aria-hidden="true" className="size-3.5" />
                </Button>
                <Button
                  aria-label="删除字段"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => controller.reshape((sheet) => removeField(sheet, index))}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </Button>
                <Switch
                  checked={!view.hidden.includes(index)}
                  onCheckedChange={(checked) =>
                    controller.configure({
                      ...view,
                      hidden: checked
                        ? view.hidden.filter((at) => at !== index)
                        : [...view.hidden, index],
                    })
                  }
                  size="sm"
                />
              </>
            )}
          </li>
        )
      })}
      <li>
        <Button
          className="justify-start"
          onClick={() => controller.reshape((sheet) => addField(sheet, nextFieldName(sheet)))}
          size="xs"
          variant="ghost"
        >
          <Plus aria-hidden="true" className="size-3.5" />
          新增字段
        </Button>
      </li>
    </ul>
  )
}

function FilterPanel({ controller, list, onClose, sheet, view }: Shell & { onClose: () => void }) {
  return (
    <ConditionPanel
      addLabel="添加筛选条件"
      count={view.filters.length}
      empty="暂无筛选条件"
      onAdd={() =>
        controller.configure({
          ...view,
          filters: [
            ...view.filters,
            { id: crypto.randomUUID(), field: 0, test: 'filled', operand: '' },
          ],
        })
      }
      onClose={onClose}
      title="筛选"
    >
      {view.filters.map((filter) => (
        <ConditionRow
          field={filter.field}
          fields={list}
          id={filter.id}
          key={filter.id}
          onField={(field) =>
            controller.configure({
              ...view,
              filters: update(view.filters, filter.id, { field, operand: '' }),
            })
          }
          onMove={(from, to) =>
            controller.configure({ ...view, filters: moveCondition(view.filters, from, to) })
          }
          onRemove={() => controller.configure({ ...view, filters: drop(view.filters, filter.id) })}
        >
          <Picker
            onSelect={(test) =>
              controller.configure({ ...view, filters: update(view.filters, filter.id, { test }) })
            }
            options={testOptions(kindAt(list, filter.field))}
            value={filter.test}
          />
          {needsOperand(filter.test) ? (
            <Operand
              choices={options(sheet, filter.field)}
              kind={kindAt(list, filter.field)}
              onChange={(operand) =>
                controller.configure({
                  ...view,
                  filters: update(view.filters, filter.id, { operand }),
                })
              }
              value={filter.operand}
            />
          ) : null}
        </ConditionRow>
      ))}
    </ConditionPanel>
  )
}

function GroupPanel({
  controller,
  list,
  onClose,
  view,
}: Omit<Shell, 'sheet'> & { onClose: () => void }) {
  return (
    <ConditionPanel
      addLabel="添加分组依据"
      count={view.groups.length}
      empty="暂无分组依据"
      onAdd={() =>
        controller.configure({
          ...view,
          groups: [...view.groups, { id: crypto.randomUUID(), field: 0 }],
        })
      }
      onClose={onClose}
      title="分组"
    >
      {view.groups.map((group) => (
        <ConditionRow
          field={group.field}
          fields={list}
          id={group.id}
          key={group.id}
          onField={(field) =>
            controller.configure({ ...view, groups: update(view.groups, group.id, { field }) })
          }
          onMove={(from, to) =>
            controller.configure({ ...view, groups: moveCondition(view.groups, from, to) })
          }
          onRemove={() => controller.configure({ ...view, groups: drop(view.groups, group.id) })}
        />
      ))}
    </ConditionPanel>
  )
}

function SortPanel({
  controller,
  list,
  onClose,
  view,
}: Omit<Shell, 'sheet'> & { onClose: () => void }) {
  return (
    <ConditionPanel
      addLabel="添加排序依据"
      count={view.sorts.length}
      empty="暂无排序依据"
      onAdd={() =>
        controller.configure({
          ...view,
          sorts: [...view.sorts, { id: crypto.randomUUID(), field: 0, descending: false }],
        })
      }
      onClose={onClose}
      title="排序"
    >
      {view.sorts.map((sort) => (
        <ConditionRow
          field={sort.field}
          fields={list}
          id={sort.id}
          key={sort.id}
          onField={(field) =>
            controller.configure({ ...view, sorts: update(view.sorts, sort.id, { field }) })
          }
          onMove={(from, to) =>
            controller.configure({ ...view, sorts: moveCondition(view.sorts, from, to) })
          }
          onRemove={() => controller.configure({ ...view, sorts: drop(view.sorts, sort.id) })}
        >
          <Picker
            onSelect={(order) =>
              controller.configure({
                ...view,
                sorts: update(view.sorts, sort.id, { descending: order === 'desc' }),
              })
            }
            options={[
              { value: 'asc', label: '升序' },
              { value: 'desc', label: '降序' },
            ]}
            value={sort.descending ? 'desc' : 'asc'}
          />
        </ConditionRow>
      ))}
    </ConditionPanel>
  )
}

function TintPanel({ controller, list, onClose, sheet, view }: Shell & { onClose: () => void }) {
  return (
    <ConditionPanel
      addLabel="添加条件"
      count={view.tints.length}
      empty="暂无填色条件"
      onAdd={() =>
        controller.configure({
          ...view,
          tints: [
            ...view.tints,
            { id: crypto.randomUUID(), field: 0, test: 'filled', operand: '', color: 'blue' },
          ],
        })
      }
      onClose={onClose}
      title="填色"
    >
      {view.tints.map((tint) => (
        <ConditionRow
          field={tint.field}
          fields={list}
          id={tint.id}
          key={tint.id}
          onField={(field) =>
            controller.configure({
              ...view,
              tints: update(view.tints, tint.id, { field, operand: '' }),
            })
          }
          onMove={(from, to) =>
            controller.configure({ ...view, tints: moveCondition(view.tints, from, to) })
          }
          onRemove={() => controller.configure({ ...view, tints: drop(view.tints, tint.id) })}
        >
          <Picker
            onSelect={(test) =>
              controller.configure({ ...view, tints: update(view.tints, tint.id, { test }) })
            }
            options={testOptions(kindAt(list, tint.field))}
            value={tint.test}
          />
          {needsOperand(tint.test) ? (
            <Operand
              choices={options(sheet, tint.field)}
              kind={kindAt(list, tint.field)}
              onChange={(operand) =>
                controller.configure({ ...view, tints: update(view.tints, tint.id, { operand }) })
              }
              value={tint.operand}
            />
          ) : null}
          <TintPicker
            color={tint.color}
            onChange={(color) =>
              controller.configure({ ...view, tints: update(view.tints, tint.id, { color }) })
            }
          />
        </ConditionRow>
      ))}
    </ConditionPanel>
  )
}

function HeightPanel({ controller, view }: Omit<Shell, 'list' | 'sheet'>) {
  return (
    <div className="flex w-40 flex-col gap-0.5">
      {HEIGHTS.map((height) => (
        <Button
          className="justify-between"
          key={height.value}
          onClick={() => controller.configure({ ...view, rowHeight: height.value })}
          size="xs"
          variant="ghost"
        >
          <span className={cn(view.rowHeight === height.value && 'font-medium')}>
            {height.label}
          </span>
          {view.rowHeight === height.value ? (
            <Check aria-hidden="true" className="size-3.5 text-primary" />
          ) : null}
        </Button>
      ))}
    </div>
  )
}

interface Shown {
  field: Field
  index: number
  key: string
}

/** 右键菜单的落点：行是底层行号，列是底层列号，行头菜单没有列。 */
interface MenuTarget {
  readonly x: number
  readonly y: number
  readonly row: number
  readonly field: number | null
}

function MenuItem({
  children,
  danger,
  disabled,
  mark: Mark,
  meta,
  onClick,
}: {
  children: ReactNode
  danger?: boolean
  disabled?: boolean
  mark: LucideIcon
  meta?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
        danger === true && 'text-destructive',
        disabled === true && 'opacity-50 hover:bg-transparent',
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Mark
        aria-hidden="true"
        className={cn('size-4 shrink-0', danger !== true && 'text-muted-foreground')}
      />
      {children}
      {meta === undefined ? null : (
        <span className="ml-auto pl-4 text-muted-foreground text-xs">{meta}</span>
      )}
    </button>
  )
}

/** 右键菜单的外壳：按住落点定位，点外面、Esc、滚动、改窗口就关。 */
function MenuShell({
  children,
  onClose,
  target,
}: {
  children: ReactNode
  onClose: () => void
  target: { x: number; y: number }
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(() => ({
    x: Math.max(8, Math.min(target.x, window.innerWidth - 232)),
    y: Math.max(8, Math.min(target.y, window.innerHeight - 320)),
  }))

  useEffect(() => {
    const node = panel.current

    if (node !== null) {
      const rect = node.getBoundingClientRect()

      setAt({
        x: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8)),
      })
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && panel.current?.contains(event.target) !== true) {
        onClose()
      }
    }
    const onScroll = (): void => onClose()

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
  }, [onClose, target.x, target.y])

  return (
    <div
      className={cn(popupSurfaceClassName, popupPositionerClassName, 'fixed w-52 p-1.5')}
      ref={panel}
      role="menu"
      style={{ left: at.x, top: at.y }}
    >
      {children}
    </div>
  )
}

/** 在上方/下方插入：数字框是菜单的一部分，点它不关菜单。 */
function InsertItem({
  above,
  count,
  onCount,
  onInsert,
  row,
}: {
  above: boolean
  count: number
  onCount: (count: number) => void
  onInsert: () => void
  row: number
}) {
  const Mark = above ? ArrowUp : ArrowDown

  return (
    <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
      <Mark aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <button
        aria-label={above ? `在第 ${row + 1} 行上方插入` : `在第 ${row + 1} 行下方插入`}
        className="flex-1 text-left"
        onClick={onInsert}
        type="button"
      >
        {above ? '在上方插入' : '在下方插入'}
      </button>
      <input
        aria-label="插入行数"
        className="h-6 w-10 rounded-md border border-input bg-background text-center text-sm outline-none"
        max={99}
        min={1}
        onChange={(event) => onCount(Number(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onInsert()
          }
        }}
        type="number"
        value={count}
      />
      <span className="text-muted-foreground">行</span>
    </div>
  )
}

/** 单元格与行头的右键菜单：前者多两项筛选，后者只有行操作。 */
function RowMenu({
  controller,
  onClose,
  target,
  view,
}: {
  controller: LibraryController
  onClose: () => void
  target: MenuTarget
  view: SheetView
}) {
  const [above, setAbove] = useState(1)
  const [below, setBelow] = useState(1)

  const onlyEmpty = (): void => {
    if (target.field === null) {
      return
    }

    controller.configure({
      ...view,
      filters: [
        ...view.filters.filter((filter) => filter.field !== target.field),
        { id: crypto.randomUUID(), field: target.field, test: 'empty', operand: '' },
      ],
    })
    onClose()
  }
  const insert = (anchor: number, count: number): void => {
    controller.revise((sheet) => insertRows(sheet, anchor, count))
    onClose()
  }

  return (
    <MenuShell onClose={onClose} target={target}>
      {target.field === null ? null : (
        <>
          <MenuItem mark={Filter} onClick={onlyEmpty}>
            不看已填写
          </MenuItem>
          <MenuItem mark={Filter} onClick={onlyEmpty}>
            只看未填写
          </MenuItem>
          <div aria-hidden="true" className="-mx-1.5 my-1 h-px bg-divider" />
        </>
      )}
      <MenuItem
        mark={Copy}
        onClick={() => {
          controller.revise((sheet) => duplicateRow(sheet, target.row))
          onClose()
        }}
      >
        创建副本
      </MenuItem>
      <InsertItem
        above={true}
        count={above}
        onCount={setAbove}
        onInsert={() => insert(target.row, above)}
        row={target.row}
      />
      <InsertItem
        above={false}
        count={below}
        onCount={setBelow}
        onInsert={() => insert(target.row + 1, below)}
        row={target.row}
      />
      <MenuItem
        danger={true}
        mark={Trash2}
        onClick={() => {
          controller.revise((sheet) => removeRow(sheet, target.row))
          onClose()
        }}
      >
        删除
      </MenuItem>
    </MenuShell>
  )
}

/** 列头的右键菜单。列宽与冻结只有样子，功能二期再做。 */
function ColumnMenu({
  controller,
  item,
  onClose,
  onEdit,
  onOpenPanel,
  target,
  view,
}: {
  controller: LibraryController
  item: Shown
  onClose: () => void
  onEdit: () => void
  onOpenPanel: (panel: 'filter' | 'group' | 'sort' | 'tint') => void
  target: { x: number; y: number }
  view: SheetView
}) {
  const act = (work: () => void): void => {
    work()
    onClose()
  }

  return (
    <MenuShell onClose={onClose} target={target}>
      <MenuItem mark={Pencil} meta={KIND_LABEL[item.field.kind]} onClick={() => act(onEdit)}>
        修改字段
      </MenuItem>
      <MenuItem
        mark={ListPlus}
        onClick={() =>
          act(() =>
            controller.reshape((sheet) => insertField(sheet, item.index + 1, nextFieldName(sheet))),
          )
        }
      >
        插入字段
      </MenuItem>
      <MenuItem
        mark={Copy}
        onClick={() => act(() => controller.reshape((sheet) => duplicateField(sheet, item.index)))}
      >
        创建副本
      </MenuItem>
      <div aria-hidden="true" className="-mx-1.5 my-1 h-px bg-divider" />
      <MenuItem mark={Filter} onClick={() => act(() => onOpenPanel('filter'))}>
        筛选
      </MenuItem>
      <MenuItem mark={Layers} onClick={() => act(() => onOpenPanel('group'))}>
        分组
      </MenuItem>
      <MenuItem mark={ArrowUpDown} onClick={() => act(() => onOpenPanel('sort'))}>
        排序
      </MenuItem>
      <MenuItem mark={Palette} onClick={() => act(() => onOpenPanel('tint'))}>
        填色
      </MenuItem>
      <div aria-hidden="true" className="-mx-1.5 my-1 h-px bg-divider" />
      <MenuItem disabled={true} mark={MoveHorizontal} onClick={() => {}}>
        调整至合适列宽
      </MenuItem>
      <MenuItem disabled={true} mark={Lock} onClick={() => {}}>
        冻结到此列
      </MenuItem>
      <MenuItem
        mark={EyeOff}
        onClick={() =>
          act(() =>
            controller.configure({
              ...view,
              hidden: view.hidden.includes(item.index) ? view.hidden : [...view.hidden, item.index],
            }),
          )
        }
      >
        隐藏字段
      </MenuItem>
      <div aria-hidden="true" className="-mx-1.5 my-1 h-px bg-divider" />
      <MenuItem
        danger={true}
        mark={Trash2}
        onClick={() => act(() => controller.reshape((sheet) => removeField(sheet, item.index)))}
      >
        删除字段
      </MenuItem>
    </MenuShell>
  )
}

function Row({
  columns,
  controller,
  list,
  menu,
  onMenu,
  row,
  shown,
  view,
}: {
  columns: string
  controller: LibraryController
  list: readonly Field[]
  menu: MenuTarget | null
  onMenu: (target: MenuTarget) => void
  row: SheetRow
  shown: readonly Shown[]
  view: SheetView
}) {
  const tint = tintOf(list, view, row)
  const ordinal = row.index + 1
  /* 行头菜单开着时这一行保持悬浮态；菜单一关状态跟着消失。 */
  const pinRow = menu !== null && menu.row === row.index && menu.field === null

  return (
    <div
      className={cn(
        'grid border-divider border-b',
        ROW_HEIGHT[view.rowHeight],
        tint === null ? undefined : TINT_CLASS[tint],
        'hover:bg-muted/50',
        pinRow && 'bg-muted/50',
      )}
      style={{ gridTemplateColumns: columns }}
    >
      <div className="flex items-center justify-center text-muted-foreground text-xs">
        <button
          aria-label={`第 ${ordinal} 行`}
          className="flex h-full w-full cursor-context-menu items-center justify-center"
          onContextMenu={(event) => {
            event.preventDefault()
            onMenu({ x: event.clientX, y: event.clientY, row: row.index, field: null })
          }}
          tabIndex={-1}
          type="button"
        >
          {ordinal}
        </button>
      </div>
      {shown.map((item) => (
        <input
          aria-label={`${item.field.name}，第 ${ordinal} 行`}
          className={cn(
            'min-w-0 border-divider border-l bg-transparent px-3 text-sm outline-none focus:bg-accent/50',
            menu !== null &&
              menu.row === row.index &&
              menu.field === item.index &&
              'ring-2 ring-inset ring-blue-500',
          )}
          key={item.key}
          onChange={(event) =>
            controller.revise(
              (sheet) => setCell(sheet, row.index, item.index, event.target.value),
              `cell:${row.index}:${item.index}`,
            )
          }
          onContextMenu={(event) => {
            event.preventDefault()
            onMenu({ x: event.clientX, y: event.clientY, row: row.index, field: item.index })
          }}
          value={row.cells[item.index] ?? ''}
        />
      ))}
      <div className="border-divider border-l" />
    </div>
  )
}

/** 列编辑面板：改名与改类型一次确认，走同一条 revise。 */
function HeaderPanel({
  controller,
  item,
  onDone,
}: {
  controller: LibraryController
  item: Shown
  onDone: () => void
}) {
  const [name, setName] = useState(item.field.name)
  const [kind, setKindOption] = useState<FieldKind>(item.field.kind)
  const [picking, setPicking] = useState(false)
  const Mark = KIND_MARK[kind]
  const clean = name.trim()
  const commit = (): void => {
    if (clean.length === 0) {
      return
    }

    controller.revise((sheet) => setKind(renameField(sheet, item.index, clean), item.index, kind))
    onDone()
  }

  if (picking) {
    return (
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {KIND_ORDER.map((option) => {
          const OptionMark = KIND_MARK[option]

          return (
            <li key={option}>
              <button
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setKindOption(option)
                  setPicking(false)
                }}
                type="button"
              >
                <OptionMark aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">{KIND_LABEL[option]}</span>
                {option === kind ? (
                  <Check aria-hidden="true" className="size-4 text-emerald-500" />
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        commit()
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">列标题</span>
        <input
          aria-label="列标题"
          className="h-9 rounded-xl border border-input bg-background px-3 text-sm outline-none"
          name="name"
          onChange={(event) => setName(event.target.value)}
          ref={(node) => {
            node?.select()
          }}
          value={name}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">类型</span>
        <button
          className="flex h-9 items-center gap-2 rounded-xl border border-input bg-background px-3 text-left text-sm"
          onClick={() => setPicking(true)}
          type="button"
        >
          <Mark aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">{KIND_LABEL[kind]}</span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
      <div className="mt-1 flex justify-end gap-2">
        <Button onClick={onDone} size="sm" type="button" variant="outline">
          取消
        </Button>
        <Button disabled={clean.length === 0} size="sm" type="submit">
          确认
        </Button>
      </div>
    </form>
  )
}

/** 列头就是这一列的入口：悬浮露出箭头，点开改名与改类型，右键出列菜单。 */
function HeaderCell({
  controller,
  editing,
  item,
  onEditChange,
  onMenu,
}: {
  controller: LibraryController
  editing: boolean
  item: Shown
  onEditChange: (editing: boolean) => void
  onMenu: (at: { x: number; y: number }) => void
}) {
  const [open, setOpen] = useState(false)
  const Mark = KIND_MARK[item.field.kind]
  const done = (): void => {
    setOpen(false)
    onEditChange(false)
  }

  return (
    <DropdownMenu
      onOpenChange={(next) => {
        setOpen(next)

        if (!next) {
          onEditChange(false)
        }
      }}
      open={open || editing}
    >
      <DropdownMenuTrigger
        className="group flex h-9 w-full items-center gap-1.5 border-divider border-l px-3 text-left text-sm hover:bg-muted"
        onContextMenu={(event) => {
          event.preventDefault()
          onMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <Mark aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{item.field.name}</span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 data-[popup-open]:opacity-100"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-3">
        <HeaderPanel controller={controller} item={item} onDone={done} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TableSurface({
  controller,
  sheet,
  view,
}: {
  controller: LibraryController
  sheet: TableSheet
  view: SheetView
}) {
  const list = useMemo(() => fields(sheet), [sheet])
  const groups = useMemo(() => project(sheet, view), [sheet, view])
  const shown = useMemo<readonly Shown[]>(
    () =>
      list
        .map((field, index) => ({ field, index, key: keyOf(index, field.name) }))
        .filter((item) => !view.hidden.includes(item.index)),
    [list, view.hidden],
  )
  const columns = `3rem repeat(${shown.length}, minmax(9rem, 1fr)) 3rem`
  const shell = { controller, list, sheet, view }
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const [column, setColumn] = useState<{ x: number; y: number; field: number } | null>(null)
  const [editingField, setEditingField] = useState<number | null>(null)
  const [panelSignal, setPanelSignal] = useState({ filter: 0, group: 0, sort: 0, tint: 0 })
  const columnItem = column === null ? undefined : shown.find((item) => item.index === column.field)
  const openPanel = (panel: 'filter' | 'group' | 'sort' | 'tint'): void => {
    setPanelSignal((signals) => ({ ...signals, [panel]: signals[panel] + 1 }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <Button onClick={() => controller.revise(addRow)} size="xs" variant="ghost">
          <CirclePlus aria-hidden="true" className="size-3.5" />
          添加一行
        </Button>
        <Panel badge={0} label="字段管理" mark={List}>
          {() => <FieldsPanel controller={controller} list={list} view={view} />}
        </Panel>
        <Panel badge={view.filters.length} label="筛选" mark={Filter} signal={panelSignal.filter}>
          {(close) => <FilterPanel {...shell} onClose={close} />}
        </Panel>
        <Panel badge={view.groups.length} label="分组" mark={Layers} signal={panelSignal.group}>
          {(close) => (
            <GroupPanel controller={controller} list={list} onClose={close} view={view} />
          )}
        </Panel>
        <Panel badge={view.sorts.length} label="排序" mark={ArrowUpDown} signal={panelSignal.sort}>
          {(close) => <SortPanel controller={controller} list={list} onClose={close} view={view} />}
        </Panel>
        <Panel badge={0} label="行高" mark={AlignJustify}>
          {() => <HeightPanel controller={controller} view={view} />}
        </Panel>
        <Panel badge={view.tints.length} label="填色" mark={Palette} signal={panelSignal.tint}>
          {(close) => <TintPanel {...shell} onClose={close} />}
        </Panel>
        <div className="flex-1" />
        <Button
          aria-label="撤销"
          onClick={controller.undo}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Undo aria-hidden="true" className="size-4" />
        </Button>
        <Button
          aria-label="重做"
          onClick={controller.redo}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Redo aria-hidden="true" className="size-4" />
        </Button>
        <div className="flex h-7 items-center gap-1.5 rounded-md bg-muted px-2">
          <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            aria-label="在表内查找"
            className="w-24 min-w-0 bg-transparent text-sm outline-none"
            onChange={(event) => controller.configure({ ...view, find: event.target.value })}
            placeholder="查找"
            type="search"
            value={view.find}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
        <div className="max-h-full overflow-auto rounded-lg border border-divider bg-background">
          <div
            className="sticky top-0 z-10 grid border-divider border-b bg-background"
            style={{ gridTemplateColumns: columns }}
          >
            <div />
            {shown.map((item) => (
              <HeaderCell
                controller={controller}
                editing={editingField === item.index}
                item={item}
                key={item.key}
                onEditChange={(editing) => setEditingField(editing ? item.index : null)}
                onMenu={(at) => setColumn({ ...at, field: item.index })}
              />
            ))}
            <button
              aria-label="新增字段"
              className="flex items-center justify-center border-divider border-l text-muted-foreground hover:bg-accent"
              onClick={() =>
                controller.reshape((current) => addField(current, nextFieldName(current)))
              }
              type="button"
            >
              <Plus aria-hidden="true" className="size-3.5" />
            </button>
          </div>
          {groups.map((group) => (
            <div key={group.label}>
              {group.label === '' ? null : (
                <div className="flex h-8 items-center gap-1.5 bg-muted/50 px-3 text-muted-foreground text-xs">
                  <Layers aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{group.label}</span>
                  <span>{group.rows.length}</span>
                </div>
              )}
              {group.rows.map((row) => (
                <Row
                  columns={columns}
                  controller={controller}
                  key={row.index}
                  list={list}
                  menu={menu}
                  onMenu={setMenu}
                  row={row}
                  shown={shown}
                  view={view}
                />
              ))}
            </div>
          ))}
          <button
            aria-label="添加一行"
            className={cn(
              'grid w-full text-muted-foreground hover:bg-accent/50',
              ROW_HEIGHT[view.rowHeight],
            )}
            onClick={() => controller.revise(addRow)}
            style={{ gridTemplateColumns: columns }}
            type="button"
          >
            <span className="flex items-center justify-center">
              <CirclePlus aria-hidden="true" className="size-4" />
            </span>
            {shown.map((item) => (
              <span className="border-divider border-l" key={item.key} />
            ))}
            <span className="border-divider border-l" />
          </button>
        </div>
      </div>
      {menu === null ? null : (
        <RowMenu controller={controller} onClose={() => setMenu(null)} target={menu} view={view} />
      )}
      {column === null || columnItem === undefined ? null : (
        <ColumnMenu
          controller={controller}
          item={columnItem}
          onClose={() => setColumn(null)}
          onEdit={() => setEditingField(column.field)}
          onOpenPanel={openPanel}
          target={column}
          view={view}
        />
      )}
    </div>
  )
}
