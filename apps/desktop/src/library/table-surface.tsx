import {
  Button,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Select,
  Switch,
} from '@poietica/design-system'
import {
  addField,
  addRow,
  type Condition,
  duplicateField,
  duplicateRow,
  type Field,
  type FieldKind,
  fields,
  type Group,
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
  type Sort,
  setCell,
  setKind,
  type TableSheet,
  type Tint,
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
  type LucideIcon,
  Palette,
  Pencil,
  Plus,
  Redo,
  Search,
  Trash2,
  Undo,
} from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConditionPanel,
  ConditionRow,
  KIND_LABEL,
  KIND_MARK,
  KIND_ORDER,
  moveCondition,
  needsOperand,
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

/*
 * 四张判据面板（筛选、分组、排序、填色）的骨架只有一份：一条判据的行、拖动换位、
 * 移除、以及「改这一条」的写回。差别只有三处 —— 数据在 view 的哪一格、新条目长
 * 什么样、这一行多画什么控件。抄成四份的话，换位判据一改就要改四处。
 */
interface ConditionPanelSpec<T extends { readonly id: string; readonly field: number }> {
  readonly addLabel: string
  readonly empty: string
  readonly fresh: () => T
  /** 换列时补全这一行的写回：筛选与填色的 operand 认的是旧列，必须一起清掉。 */
  readonly onField: (field: number) => Partial<T>
  readonly rows: (view: SheetView) => readonly T[]
  readonly title: string
  readonly write: (view: SheetView, rows: readonly T[]) => SheetView
}

function ConditionRows<T extends { readonly id: string; readonly field: number }>({
  controller,
  list,
  onClose,
  panel,
  render,
  view,
}: Omit<Shell, 'sheet'> & {
  readonly onClose: () => void
  readonly panel: ConditionPanelSpec<T>
  readonly render: (row: T, write: (change: Partial<T>) => void) => ReactNode
}) {
  const rows = panel.rows(view)
  const write = (next: readonly T[]) => controller.configure(panel.write(view, next))

  return (
    <ConditionPanel
      addLabel={panel.addLabel}
      count={rows.length}
      empty={panel.empty}
      onAdd={() => write([...rows, panel.fresh()])}
      onClose={onClose}
      title={panel.title}
    >
      {rows.map((row) => (
        <ConditionRow
          field={row.field}
          fields={list}
          id={row.id}
          key={row.id}
          onField={(field) => write(update(rows, row.id, panel.onField(field)))}
          onMove={(from, to) => write(moveCondition(rows, from, to))}
          onRemove={() => write(drop(rows, row.id))}
        >
          {render(row, (change) => write(update(rows, row.id, change)))}
        </ConditionRow>
      ))}
    </ConditionPanel>
  )
}

const FILTER_PANEL: ConditionPanelSpec<Condition> = {
  addLabel: '添加筛选条件',
  empty: '暂无筛选条件',
  fresh: () => ({ id: crypto.randomUUID(), field: 0, test: 'filled', operand: '' }),
  onField: (field) => ({ field, operand: '' }),
  rows: (view) => view.filters,
  title: '筛选',
  write: (view, filters) => ({ ...view, filters }),
}

const GROUP_PANEL: ConditionPanelSpec<Group> = {
  addLabel: '添加分组依据',
  empty: '暂无分组依据',
  fresh: () => ({ id: crypto.randomUUID(), field: 0 }),
  onField: (field) => ({ field }),
  rows: (view) => view.groups,
  title: '分组',
  write: (view, groups) => ({ ...view, groups }),
}

const SORT_PANEL: ConditionPanelSpec<Sort> = {
  addLabel: '添加排序依据',
  empty: '暂无排序依据',
  fresh: () => ({ id: crypto.randomUUID(), field: 0, descending: false }),
  onField: (field) => ({ field }),
  rows: (view) => view.sorts,
  title: '排序',
  write: (view, sorts) => ({ ...view, sorts }),
}

const TINT_PANEL: ConditionPanelSpec<Tint> = {
  addLabel: '添加条件',
  empty: '暂无填色条件',
  fresh: () => ({ id: crypto.randomUUID(), field: 0, test: 'filled', operand: '', color: 'blue' }),
  onField: (field) => ({ field, operand: '' }),
  rows: (view) => view.tints,
  title: '填色',
  write: (view, tints) => ({ ...view, tints }),
}

function FilterPanel({ controller, list, onClose, sheet, view }: Shell & { onClose: () => void }) {
  return (
    <ConditionRows
      controller={controller}
      list={list}
      onClose={onClose}
      panel={FILTER_PANEL}
      render={(filter, write) => (
        <>
          <Select
            className="min-w-0 flex-1"
            data={testOptions(kindAt(list, filter.field))}
            onValueChange={(test) => write({ test })}
            type="判据"
            value={filter.test}
          />
          {needsOperand(filter.test) ? (
            <Operand
              choices={options(sheet, filter.field)}
              kind={kindAt(list, filter.field)}
              onChange={(operand) => write({ operand })}
              value={filter.operand}
            />
          ) : null}
        </>
      )}
      view={view}
    />
  )
}

function GroupPanel({
  controller,
  list,
  onClose,
  view,
}: Omit<Shell, 'sheet'> & { onClose: () => void }) {
  return (
    <ConditionRows
      controller={controller}
      list={list}
      onClose={onClose}
      panel={GROUP_PANEL}
      render={() => null}
      view={view}
    />
  )
}

function SortPanel({
  controller,
  list,
  onClose,
  view,
}: Omit<Shell, 'sheet'> & { onClose: () => void }) {
  return (
    <ConditionRows
      controller={controller}
      list={list}
      onClose={onClose}
      panel={SORT_PANEL}
      render={(sort, write) => (
        <Select
          className="min-w-0 flex-1"
          data={[
            { value: 'asc', label: '升序' },
            { value: 'desc', label: '降序' },
          ]}
          onValueChange={(order) => write({ descending: order === 'desc' })}
          type="顺序"
          value={sort.descending ? 'desc' : 'asc'}
        />
      )}
      view={view}
    />
  )
}

function TintPanel({ controller, list, onClose, sheet, view }: Shell & { onClose: () => void }) {
  return (
    <ConditionRows
      controller={controller}
      list={list}
      onClose={onClose}
      panel={TINT_PANEL}
      render={(tint, write) => (
        <>
          <Select
            className="min-w-0 flex-1"
            data={testOptions(kindAt(list, tint.field))}
            onValueChange={(test) => write({ test })}
            type="判据"
            value={tint.test}
          />
          {needsOperand(tint.test) ? (
            <Operand
              choices={options(sheet, tint.field)}
              kind={kindAt(list, tint.field)}
              onChange={(operand) => write({ operand })}
              value={tint.operand}
            />
          ) : null}
          <TintPicker color={tint.color} onChange={(color) => write({ color })} />
        </>
      )}
      view={view}
    />
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

type MenuTarget =
  | { readonly of: 'row'; readonly row: number; readonly field: number | null }
  | { readonly of: 'column'; readonly field: number }

function menuTargetAt(target: EventTarget | null): MenuTarget | null {
  if (!(target instanceof Element)) {
    return null
  }

  const field = target.closest<HTMLElement>('[data-sheet-field]')?.dataset['sheetField']
  const row = target.closest<HTMLElement>('[data-sheet-row]')?.dataset['sheetRow']

  if (row !== undefined) {
    return { of: 'row', row: Number(row), field: field === undefined ? null : Number(field) }
  }

  return field === undefined ? null : { of: 'column', field: Number(field) }
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
    <ContextMenuItem
      className={cn(danger === true && 'text-destructive')}
      disabled={disabled}
      onClick={onClick}
    >
      <Mark
        aria-hidden="true"
        className={cn('size-4 shrink-0', danger !== true && 'text-muted-foreground')}
      />
      {children}
      {meta === undefined ? null : (
        <span className="ml-auto pl-4 text-muted-foreground text-xs">{meta}</span>
      )}
    </ContextMenuItem>
  )
}

function RowItems({
  controller,
  target,
  view,
}: {
  controller: LibraryController
  target: { readonly row: number; readonly field: number | null }
  view: SheetView
}) {
  const field = target.field

  return (
    <>
      {field === null ? null : (
        <>
          <MenuItem
            mark={Filter}
            onClick={() =>
              controller.configure({
                ...view,
                filters: [
                  ...view.filters.filter((filter) => filter.field !== field),
                  { id: crypto.randomUUID(), field, test: 'empty', operand: '' },
                ],
              })
            }
          >
            只看未填写
          </MenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <MenuItem
        mark={Copy}
        onClick={() => controller.revise((sheet) => duplicateRow(sheet, target.row))}
      >
        创建副本
      </MenuItem>
      <MenuItem
        mark={ArrowUp}
        onClick={() => controller.revise((sheet) => insertRows(sheet, target.row, 1))}
      >
        在上方插入
      </MenuItem>
      <MenuItem
        mark={ArrowDown}
        onClick={() => controller.revise((sheet) => insertRows(sheet, target.row + 1, 1))}
      >
        在下方插入
      </MenuItem>
      <MenuItem
        danger={true}
        mark={Trash2}
        onClick={() => controller.revise((sheet) => removeRow(sheet, target.row))}
      >
        删除
      </MenuItem>
    </>
  )
}

function ColumnItems({
  controller,
  item,
  onEdit,
  onOpenPanel,
  view,
}: {
  controller: LibraryController
  item: Shown
  onEdit: () => void
  onOpenPanel: (panel: 'filter' | 'group' | 'sort' | 'tint') => void
  view: SheetView
}) {
  return (
    <>
      <MenuItem mark={Pencil} meta={KIND_LABEL[item.field.kind]} onClick={onEdit}>
        修改字段
      </MenuItem>
      <MenuItem
        mark={ListPlus}
        onClick={() =>
          controller.reshape((sheet) => insertField(sheet, item.index + 1, nextFieldName(sheet)))
        }
      >
        插入字段
      </MenuItem>
      <MenuItem
        mark={Copy}
        onClick={() => controller.reshape((sheet) => duplicateField(sheet, item.index))}
      >
        创建副本
      </MenuItem>
      <ContextMenuSeparator />
      <MenuItem mark={Filter} onClick={() => onOpenPanel('filter')}>
        筛选
      </MenuItem>
      <MenuItem mark={Layers} onClick={() => onOpenPanel('group')}>
        分组
      </MenuItem>
      <MenuItem mark={ArrowUpDown} onClick={() => onOpenPanel('sort')}>
        排序
      </MenuItem>
      <MenuItem mark={Palette} onClick={() => onOpenPanel('tint')}>
        填色
      </MenuItem>
      <ContextMenuSeparator />
      <MenuItem
        mark={EyeOff}
        onClick={() =>
          controller.configure({
            ...view,
            hidden: view.hidden.includes(item.index) ? view.hidden : [...view.hidden, item.index],
          })
        }
      >
        隐藏字段
      </MenuItem>
      <ContextMenuSeparator />
      <MenuItem
        danger={true}
        mark={Trash2}
        onClick={() => controller.reshape((sheet) => removeField(sheet, item.index))}
      >
        删除字段
      </MenuItem>
    </>
  )
}

function Row({
  controller,
  list,
  menu,
  row,
  shown,
  view,
}: {
  controller: LibraryController
  list: readonly Field[]
  menu: MenuTarget | null
  row: SheetRow
  shown: readonly Shown[]
  view: SheetView
}) {
  const tint = tintOf(list, view, row)
  const ordinal = row.index + 1
  const held = menu?.of === 'row' && menu.row === row.index ? menu : null
  const pinRow = held !== null && held.field === null

  return (
    <div
      className={cn(
        'grid border-divider border-b',
        ROW_HEIGHT[view.rowHeight],
        '[grid-template-columns:var(--sheet-columns)]',
        tint === null ? undefined : TINT_CLASS[tint],
        'hover:bg-muted/50',
        pinRow && 'bg-muted/50',
      )}
    >
      <div className="flex items-center justify-center text-muted-foreground text-xs">
        <button
          aria-label={`第 ${ordinal} 行`}
          className="flex h-full w-full cursor-context-menu items-center justify-center"
          data-sheet-row={row.index}
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
            held !== null && held.field === item.index && 'ring-2 ring-inset ring-blue-500',
          )}
          data-sheet-field={item.index}
          data-sheet-row={row.index}
          key={item.key}
          onChange={(event) =>
            controller.revise(
              (sheet) => setCell(sheet, row.index, item.index, event.target.value),
              `cell:${row.index}:${item.index}`,
            )
          }
          value={row.cells[item.index] ?? ''}
        />
      ))}
      <div className="border-divider border-l" />
    </div>
  )
}

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

function HeaderCell({
  controller,
  editing,
  item,
  onEditChange,
}: {
  controller: LibraryController
  editing: boolean
  item: Shown
  onEditChange: (editing: boolean) => void
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
        data-sheet-field={item.index}
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
  const [editingField, setEditingField] = useState<number | null>(null)
  const [panelSignal, setPanelSignal] = useState({ filter: 0, group: 0, sort: 0, tint: 0 })
  const columnItem =
    menu?.of === 'column' ? shown.find((item) => item.index === menu.field) : undefined
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
        <ContextMenuRoot
          onOpenChange={(open) => {
            if (!open) {
              setMenu(null)
            }
          }}
        >
          <div
            className="max-h-full overflow-auto rounded-lg border border-divider bg-background"
            style={{ '--sheet-columns': columns } as CSSProperties}
          >
            <ContextMenuTrigger
              onContextMenu={(event) => {
                const found = menuTargetAt(event.target)

                if (found === null) {
                  event.preventBaseUIHandler()

                  return
                }

                setMenu(found)
              }}
            >
              <div className="sticky top-0 z-10 grid border-divider border-b bg-background [grid-template-columns:var(--sheet-columns)]">
                <div />
                {shown.map((item) => (
                  <HeaderCell
                    controller={controller}
                    editing={editingField === item.index}
                    item={item}
                    key={item.key}
                    onEditChange={(editing) => setEditingField(editing ? item.index : null)}
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
                      controller={controller}
                      key={row.index}
                      list={list}
                      menu={menu}
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
                  'grid w-full text-muted-foreground hover:bg-accent/50 [grid-template-columns:var(--sheet-columns)]',
                  ROW_HEIGHT[view.rowHeight],
                )}
                onClick={() => controller.revise(addRow)}
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
            </ContextMenuTrigger>
          </div>
          <ContextMenuContent className="w-52">
            {menu === null ? null : menu.of === 'row' ? (
              <RowItems controller={controller} target={menu} view={view} />
            ) : columnItem === undefined ? null : (
              <ColumnItems
                controller={controller}
                item={columnItem}
                onEdit={() => setEditingField(menu.field)}
                onOpenPanel={openPanel}
                view={view}
              />
            )}
          </ContextMenuContent>
        </ContextMenuRoot>
      </div>
    </div>
  )
}
