import { Combobox as BaseCombobox } from '@base-ui/react/combobox'
import type { ReactNode } from 'react'
import { cn } from '../class-names'
import './command-menu.css'

export interface CommandMenuItem {
  readonly value: string
  readonly label: string
  /** 行尾那一小行灰字：同名的行靠它区分。 */
  readonly detail?: string
  readonly shortcut?: string
  /** 行首图标：快捷操作用它区分动作，纯会话项不画。 */
  readonly icon?: ReactNode
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
      {/*
       * 输入框不画放大镜、不画底部分隔线：占位符本身就是"搜索聊天"，
       * 再叠一个图标和一条线只会把顶部压重。间距靠 padding 撑开。
       */}
      <div className={cn('px-5', 'py-4')}>
        <BaseCombobox.Input
          aria-label={ariaLabel}
          autoFocus
          className={cn(
            'h-8 w-full',
            'border-0 bg-transparent',
            'text-sm',
            'text-foreground',
            'outline-none shadow-none',
            'placeholder:text-placeholder',
          )}
          placeholder={placeholder}
        />
      </div>

      <BaseCombobox.List
        className={cn(
          'command-menu__list',
          'max-h-[32rem]',
          'overflow-y-auto',
          'overscroll-contain',
          'px-2 pb-2 outline-none',
        )}
      >
        {groups.map((group) => (
          <BaseCombobox.Group className="mb-1 last:mb-0" key={group.id}>
            <BaseCombobox.GroupLabel
              className={cn('px-3 py-1.5', 'text-sm', 'text-muted-foreground')}
            >
              {group.title}
            </BaseCombobox.GroupLabel>

            {group.items.map((item) => (
              <BaseCombobox.Item
                className={cn(
                  'flex min-h-10',
                  'w-full items-center',
                  'gap-3 rounded-lg',
                  'px-3 text-left',
                  'text-sm outline-none',
                  'cursor-default select-none',
                  'data-[highlighted]:bg-accent',
                  'data-[highlighted]:text-accent-foreground',
                )}
                key={item.value}
                value={item.value}
              >
                {item.icon === undefined ? null : (
                  <span className={cn('shrink-0', 'text-muted-foreground')}>{item.icon}</span>
                )}

                <span className={cn('min-w-0 flex-1', 'truncate')}>{item.label}</span>

                {item.detail === undefined ? null : (
                  <span
                    className={cn('max-w-40 shrink-0 truncate', 'text-xs', 'text-muted-foreground')}
                  >
                    {item.detail}
                  </span>
                )}

                {item.shortcut === undefined ? null : (
                  <kbd
                    className={cn(
                      'shrink-0 rounded-md bg-muted px-1.5 py-0.5',
                      'text-xs tabular-nums',
                      'text-muted-foreground',
                    )}
                  >
                    {item.shortcut}
                  </kbd>
                )}
              </BaseCombobox.Item>
            ))}
          </BaseCombobox.Group>
        ))}

        {/*
         * Empty 的根节点永远挂载（读屏播报用），有结果时只清空子节点。
         * 占位尺寸必须写在子节点上 —— 写在根上会在有结果时留下一块空白。
         */}
        <BaseCombobox.Empty className={cn('outline-none')}>
          <span
            className={cn('grid min-h-28', 'place-content-center', 'gap-1 px-4', 'text-center')}
          >
            <span className={cn('text-sm font-medium', 'text-foreground')}>{emptyTitle}</span>

            <span className={cn('text-xs', 'text-muted-foreground')}>{emptyDescription}</span>
          </span>
        </BaseCombobox.Empty>
      </BaseCombobox.List>
    </BaseCombobox.Root>
  )
}
