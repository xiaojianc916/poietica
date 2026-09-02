import { Combobox } from '@base-ui/react/combobox'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '../class-names'
import { popupPositionerClassName, popupSurfaceClassName } from './popup-surface'
import type { SelectOption } from './select'
import './searchable-select.css'

export interface SearchableSelectProps<TValue extends string = string> {
  readonly data: readonly SelectOption<TValue>[]
  readonly type: string
  readonly value: TValue
  readonly onValueChange: (value: TValue) => void
  readonly className?: string
  readonly id?: string
}

export function SearchableSelect<TValue extends string = string>({
  data,
  type,
  value,
  onValueChange,
  className,
  id,
}: SearchableSelectProps<TValue>) {
  const selected = data.find((option) => option.value === value) ?? null
  return (
    <Combobox.Root<SelectOption<TValue>>
      isItemEqualToValue={(left, right) => left.value === right.value}
      items={data}
      onValueChange={(option) => {
        if (option !== null) {
          onValueChange(option.value)
        }
      }}
      value={selected}
    >
      <Combobox.Trigger
        aria-label={type}
        className={cn(
          'flex h-[30px] w-full items-center justify-between gap-2 rounded-lg bg-surface px-2 text-xs text-foreground outline-none transition-colors hover:bg-[var(--ui-popup-highlight)] focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        id={id}
        type="button"
      >
        <Combobox.Value placeholder={`选择${type}…`} />
        <Combobox.Icon>
          <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner className={popupPositionerClassName} sideOffset={4}>
          {/*
           * 与 Select.tsx 同源策略：宽度走"锚点宽度只是下限、上限 320px、内容
           * 自适应"，不写死 width / max-w：[min(320px,var(--available-width))]
           * 会被 base-ui 碰撞检测给出的极小 --available-width 压扁，行内高度被
           * 拆成单字符的竖排。minInlineSize / maxInlineSize 比 tailwind 任意值
           * 更清楚表达"下限/上限"的语义。
           */}
          <Combobox.Popup
            aria-label={`选择${type}`}
            className={popupSurfaceClassName}
            style={{
              minInlineSize: `max(var(--anchor-width), 240px)`,
              maxInlineSize: '320px',
            }}
          >
            <div className="flex items-center gap-2 border-b border-divider px-2">
              <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <Combobox.Input
                aria-label={`搜索${type}`}
                autoFocus
                className="h-9 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-placeholder"
                placeholder={`搜索${type}`}
              />
            </div>
            <Combobox.Empty className="px-3 py-5 text-center text-xs text-muted-foreground">
              没有匹配项
            </Combobox.Empty>
            <Combobox.List className="searchable-select__list grid max-h-64 gap-0.5 overflow-y-auto overscroll-contain p-1 outline-none">
              {(option: SelectOption<TValue>) => (
                <Combobox.Item
                  className="flex min-h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-xs outline-none transition-colors data-[highlighted]:bg-[var(--ui-popup-highlight)]"
                  key={option.value}
                  value={option}
                >
                  {/* base-ui 1.7.0 无 Combobox.ItemText，纯文本子节点即可参与过滤（stringifyAsLabel 走 item.label）。ItemIndicator 用 ml-auto 把勾号推到行末，文字才能 flex-1 拿到完整宽度。 */}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <Combobox.ItemIndicator className="ml-auto shrink-0">
                    <Check aria-hidden="true" className="size-4" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
