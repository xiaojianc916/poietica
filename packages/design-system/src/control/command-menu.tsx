import { Combobox as BaseCombobox } from '@base-ui/react/combobox'
import { Search } from 'lucide-react'
import { cn } from '../class-names'

export interface CommandMenuItem {
  readonly value: string
  readonly label: string
  /** 行尾那一小行灰字：同名的行靠它区分。 */
  readonly detail?: string
  readonly shortcut?: string
}

/**
 * 一组。
 *
 * 组是这个控件的一等公民，不是行上的一个属性。此前 category 画在行尾，于是
 * 同一类的十条各自重复十遍类名，而「这里开始是另一类了」这件事没有任何视觉
 * 或语义上的表达 —— 读屏软件读到的是一条一百项的平列表。
 */
export interface CommandMenuGroup {
  readonly id: string
  readonly title: string
  readonly items: readonly CommandMenuItem[]
}

export interface CommandMenuProps {
  readonly groups: readonly CommandMenuGroup[]
  readonly query: string
  readonly placeholder?: string
  readonly ariaLabel: string
  readonly emptyTitle?: string
  readonly emptyDescription?: string
  readonly onQueryChange: (query: string) => void
  readonly onSelect: (value: string) => void
}

/**
 * Accessible inline command selection pattern.
 *
 * Base UI owns:
 * - highlighted-item state
 * - list navigation across groups
 * - Home and End behavior
 * - Enter selection
 * - active-descendant semantics
 * - group labelling (role="group" + aria-labelledby)
 *
 * Consumers own:
 * - command registration
 * - filtering policy
 * - grouping and section order
 * - execution
 * - business labels
 */
export function CommandMenu({
  groups,
  query,
  placeholder = '搜索聊天',
  ariaLabel,
  emptyTitle = '没有匹配的结果',
  emptyDescription = '换个说法，或者按 Esc 关闭。',
  onQueryChange,
  onSelect,
}: CommandMenuProps) {
  const items = groups.flatMap((group) => group.items)

  const itemValues = items.map((item) => item.value)

  const itemMap = new Map(items.map((item) => [item.value, item]))

  return (
    <BaseCombobox.Root<string>
      autoHighlight
      filter={null}
      inline
      inputValue={query}
      items={itemValues}
      itemToStringLabel={(value) => itemMap.get(value)?.label ?? value}
      onInputValueChange={(nextQuery) => {
        onQueryChange(nextQuery)
      }}
      onValueChange={(nextValue) => {
        if (nextValue !== null) {
          onSelect(nextValue)
        }
      }}
      open
      value={null}
    >
      <div className={cn('flex items-center gap-2', 'border-b border-divider', 'px-4')}>
        <Search aria-hidden="true" className={cn('size-4 shrink-0', 'text-muted-foreground')} />

        <BaseCombobox.Input
          aria-label={ariaLabel}
          autoFocus
          className={cn(
            'h-11 min-w-0 flex-1',
            'border-0 bg-transparent',
            'px-0 text-sm',
            'text-foreground',
            'outline-none shadow-none',
            'placeholder:text-placeholder',
          )}
          placeholder={placeholder}
        />
      </div>

      <BaseCombobox.List
        className={cn('max-h-96', 'overflow-y-auto', 'overscroll-contain', 'p-1.5 outline-none')}
      >
        {groups.map((group) => (
          <BaseCombobox.Group className="mb-1 last:mb-0" key={group.id}>
            <BaseCombobox.GroupLabel
              className={cn('px-2.5 py-1.5', 'text-xs', 'text-muted-foreground')}
            >
              {group.title}
            </BaseCombobox.GroupLabel>

            {group.items.map((item) => (
              <BaseCombobox.Item
                className={cn(
                  'flex min-h-8',
                  'w-full items-center',
                  'gap-3 rounded-md',
                  'px-2.5 text-left',
                  'text-sm outline-none',
                  'cursor-default select-none',
                  'data-[highlighted]:bg-accent',
                  'data-[highlighted]:text-accent-foreground',
                )}
                key={item.value}
                value={item.value}
              >
                <span className={cn('min-w-0 flex-1', 'truncate')}>{item.label}</span>

                {item.detail === undefined ? null : (
                  <span
                    className={cn('max-w-40 shrink-0 truncate', 'text-xs', 'text-muted-foreground')}
                  >
                    {item.detail}
                  </span>
                )}

                {item.shortcut === undefined ? null : (
                  <kbd className={cn('shrink-0 text-xs', 'tabular-nums', 'text-muted-foreground')}>
                    {item.shortcut}
                  </kbd>
                )}
              </BaseCombobox.Item>
            ))}
          </BaseCombobox.Group>
        ))}

        <BaseCombobox.Empty
          className={cn('grid min-h-28', 'place-content-center', 'gap-1 px-4', 'text-center')}
        >
          <span className={cn('text-sm font-medium', 'text-foreground')}>{emptyTitle}</span>

          <span className={cn('text-xs', 'text-muted-foreground')}>{emptyDescription}</span>
        </BaseCombobox.Empty>
      </BaseCombobox.List>
    </BaseCombobox.Root>
  )
}
