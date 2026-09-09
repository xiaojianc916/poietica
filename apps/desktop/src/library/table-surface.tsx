import {
  Button,
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
  type Field,
  type FieldKind,
  fields,
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
  type TableSheet,
  tintOf,
} from '@poietica/library'
import {
  AlignJustify,
  ArrowUpDown,
  Calendar,
  ChevronDown,
  Filter,
  GripVertical,
  Hash,
  Layers,
  List,
  Palette,
  Pencil,
  Plus,
  Redo,
  Search,
  Trash2,
  Type,
  Undo,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import {
  ConditionPanel,
  ConditionRow,
  needsOperand,
  TINT_CLASS,
  TintPicker,
  testOptions,
} from './condition-list'

const ROW_HEIGHT: Record<RowHeight, string> = { short: 'h-9', medium: 'h-12', tall: 'h-16' }

const HEIGHTS: readonly { value: RowHeight; label: string }[] = [
  { value: 'short', label: '矮' },
  { value: 'medium', label: '中' },
  { value: 'tall', label: '高' },
]

const KIND_MARK: Record<FieldKind, typeof Type> = {
  text: Type,
  number: Hash,
  select: ChevronDown,
  date: Calendar,
}

const INPUT_TYPE: Record<FieldKind, 'text' | 'number' | 'date'> = {
  text: 'text',
  select: 'text',
  number: 'number',
  date: 'date',
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
}: {
  badge: number
  children: ReactNode
  label: string
  mark: typeof Filter
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-7 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-accent">
        <Mark aria-hidden="true" className="size-3.5 text-muted-foreground" />
        {label}
        {badge === 0 ? null : (
          <span className="rounded bg-primary/15 px-1 text-primary text-xs">{badge}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
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
  if (kind === 'select' && choices.length > 0) {
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

function FilterPanel({ controller, list, sheet, view }: Shell) {
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
    >
      {view.filters.map((filter) => (
        <ConditionRow
          field={filter.field}
          fields={list}
          key={filter.id}
          onField={(field) =>
            controller.configure({
              ...view,
              filters: update(view.filters, filter.id, { field, operand: '' }),
            })
          }
          onRemove={() => controller.configure({ ...view, filters: drop(view.filters, filter.id) })}
        >
          <Select
            className="min-w-20"
            data={testOptions(kindAt(list, filter.field))}
            onValueChange={(test) =>
              controller.configure({ ...view, filters: update(view.filters, filter.id, { test }) })
            }
            type="取法"
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

function GroupPanel({ controller, list, view }: Omit<Shell, 'sheet'>) {
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
    >
      {view.groups.map((group) => (
        <ConditionRow
          field={group.field}
          fields={list}
          key={group.id}
          onField={(field) =>
            controller.configure({ ...view, groups: update(view.groups, group.id, { field }) })
          }
          onRemove={() => controller.configure({ ...view, groups: drop(view.groups, group.id) })}
        />
      ))}
    </ConditionPanel>
  )
}

function SortPanel({ controller, list, view }: Omit<Shell, 'sheet'>) {
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
    >
      {view.sorts.map((sort) => (
        <ConditionRow
          field={sort.field}
          fields={list}
          key={sort.id}
          onField={(field) =>
            controller.configure({ ...view, sorts: update(view.sorts, sort.id, { field }) })
          }
          onRemove={() => controller.configure({ ...view, sorts: drop(view.sorts, sort.id) })}
        >
          <Select
            className="min-w-20"
            data={[
              { value: 'asc', label: '升序' },
              { value: 'desc', label: '降序' },
            ]}
            onValueChange={(order) =>
              controller.configure({
                ...view,
                sorts: update(view.sorts, sort.id, { descending: order === 'desc' }),
              })
            }
            type="顺序"
            value={sort.descending ? 'desc' : 'asc'}
          />
        </ConditionRow>
      ))}
    </ConditionPanel>
  )
}

function TintPanel({ controller, list, sheet, view }: Shell) {
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
            { id: crypto.randomUUID(), field: 0, test: 'any', operand: '', color: 'blue' },
          ],
        })
      }
    >
      {view.tints.map((tint) => (
        <ConditionRow
          field={tint.field}
          fields={list}
          key={tint.id}
          onField={(field) =>
            controller.configure({
              ...view,
              tints: update(view.tints, tint.id, { field, operand: '' }),
            })
          }
          onRemove={() => controller.configure({ ...view, tints: drop(view.tints, tint.id) })}
        >
          <Select
            className="min-w-20"
            data={testOptions(kindAt(list, tint.field))}
            onValueChange={(test) =>
              controller.configure({ ...view, tints: update(view.tints, tint.id, { test }) })
            }
            type="取法"
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
          className={cn('justify-start', view.rowHeight === height.value && 'bg-accent')}
          key={height.value}
          onClick={() => controller.configure({ ...view, rowHeight: height.value })}
          size="xs"
          variant="ghost"
        >
          {height.label}
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

function Row({
  columns,
  controller,
  list,
  row,
  shown,
  view,
}: {
  columns: string
  controller: LibraryController
  list: readonly Field[]
  row: SheetRow
  shown: readonly Shown[]
  view: SheetView
}) {
  const tint = tintOf(list, view, row)
  const ordinal = row.index + 1

  return (
    <div
      className={cn(
        'group grid border-divider border-b',
        ROW_HEIGHT[view.rowHeight],
        tint === null ? undefined : TINT_CLASS[tint],
      )}
      style={{ gridTemplateColumns: columns }}
    >
      <div className="flex items-center justify-center text-muted-foreground text-xs">
        <span className="group-hover:hidden">{ordinal}</span>
        <button
          aria-label={`删除第 ${ordinal} 行`}
          className="hidden group-hover:block"
          onClick={() => controller.revise((sheet) => removeRow(sheet, row.index))}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {shown.map((item) => (
        <input
          aria-label={`${item.field.name}，第 ${ordinal} 行`}
          className="min-w-0 border-divider border-l bg-transparent px-3 text-sm outline-none focus:bg-accent/50"
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-divider border-b px-3">
        <Button onClick={() => controller.revise(addRow)} size="xs" variant="ghost">
          <Plus aria-hidden="true" className="size-3.5" />
          添加一行
        </Button>
        <Panel badge={0} label="字段管理" mark={List}>
          <FieldsPanel controller={controller} list={list} view={view} />
        </Panel>
        <Panel badge={view.filters.length} label="筛选" mark={Filter}>
          <FilterPanel {...shell} />
        </Panel>
        <Panel badge={view.groups.length} label="分组" mark={Layers}>
          <GroupPanel controller={controller} list={list} view={view} />
        </Panel>
        <Panel badge={view.sorts.length} label="排序" mark={ArrowUpDown}>
          <SortPanel controller={controller} list={list} view={view} />
        </Panel>
        <Panel badge={0} label="行高" mark={AlignJustify}>
          <HeightPanel controller={controller} view={view} />
        </Panel>
        <Panel badge={view.tints.length} label="填色" mark={Palette}>
          <TintPanel {...shell} />
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
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="sticky top-0 z-10 grid border-divider border-b bg-background"
          style={{ gridTemplateColumns: columns }}
        >
          <div />
          {shown.map((item) => {
            const Mark = KIND_MARK[item.field.kind]

            return (
              <div
                className="flex h-9 items-center gap-1.5 border-divider border-l px-3 text-sm"
                key={item.key}
              >
                <Mark aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.field.name}</span>
              </div>
            )
          })}
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
                row={row}
                shown={shown}
                view={view}
              />
            ))}
          </div>
        ))}
        <button
          className="flex h-9 w-full items-center gap-1.5 px-3 text-muted-foreground text-sm hover:bg-accent"
          onClick={() => controller.revise(addRow)}
          type="button"
        >
          <Plus aria-hidden="true" className="size-3.5" />
          添加一行
        </button>
      </div>
    </div>
  )
}
