import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../class-names'
import { popupPositionerClassName, popupSurfaceClassName } from './popup-surface'

/** 类型参数保留选项值的字面量联合，避免调用点转换形状或断言类型。 */
export interface SelectOption<TValue extends string = string> {
  readonly value: TValue
  readonly label: string
  /**
   * 行首图标。
   *
   * 名字彼此只差一个序号时（字段列表就是「字段 1」「字段 2」），图标是唯一一眼能
   * 分出种类的东西。触发器与清单画同一份 —— 分开画就是两个产地。
   */
  readonly mark?: ReactNode
}

export interface SelectProps<TValue extends string = string> {
  /** 全部可选值。触发器上的标签与列表里的行都由它渲染，只有这一个产地。 */
  readonly data: readonly SelectOption<TValue>[]
  /** 选项类型同时提供占位文案「选择{type}…」与触发器的可访问名，避免两者分叉。 */
  readonly type: string
  readonly value: TValue
  /** 面板沿触发器的哪一条边展开。值右对齐的行用 end，与触发器同一条边。 */
  readonly align?: 'start' | 'end'
  /** 触发器在所在版面里的宽度约束。面板与每一行的样式不对外开放。 */
  readonly className?: string
  /** 触发器的 id，用于外部 <label htmlFor> 关联。 */
  readonly id?: string
  readonly onValueChange: (value: TValue) => void
}

/*
 * cn 靠后的类覆盖靠前的冲突类，调用点的 className 因此排在最后。
 *
 * 触发器与展开的面板同属一个控件：底取 --ui-popover（收起与展开同色），框取
 * --ui-popover-trigger-frame（比面板那圈轻一档）。两处都由令牌给值，不再写死
 * 白底与浅色线。
 */
const TRIGGER = cn(
  'flex items-center justify-between',
  'text-left text-foreground',
  'outline-none',
  'transition-[border-color,box-shadow,background-color]',
  'focus-visible:ring-2',
  'focus-visible:ring-ring',
  'disabled:cursor-not-allowed',
  'disabled:opacity-50',
  'h-[26px] gap-1 px-2 text-xs',
  'w-auto max-w-full rounded-lg border border-divider [--color-divider:var(--ui-popover-trigger-frame)] bg-popover hover:bg-[var(--ui-popup-highlight)] data-[popup-open]:bg-[var(--ui-popup-highlight)]',
)

/* 触发器与清单里的字都是这一个盒子：图标另起一格，字占住剩下的并自己省略号收尾。 */
const VALUE = cn('min-w-0 flex-1', 'truncate')

const TRIGGER_VALUE = cn('flex min-w-0 flex-1', 'items-center gap-1.5')

const MARK = cn('flex shrink-0', 'items-center', 'text-muted-foreground')

/*
 * ChevronDown 而不是 ChevronsUpDown：双向箭头说的是「有一根轴能上下走」，那是
 * 步进器与可搜索输入的记号。这里是有限离散值的弹出菜单，说的是「下面会展开一
 * 张列表」。
 */
const ICON = cn('size-3.5', 'shrink-0', 'text-muted-foreground/60')

/* 无分组标题，间距由列表承担，无需额外分组层。 */
const LIST = cn(
  'max-h-64',
  'overflow-y-auto',
  'overscroll-contain',
  'p-1 outline-none',
  'grid gap-0.5',
)

/*
 * 行高比触发器高 2px，字号与触发器同档：菜单是控件的展开，不是新界面。
 *
 * 高亮是中性的：勾号说「当前生效的值」，高亮说「指针或键盘现在指着谁」。用
 * --ui-accent 去画一个瞬时指向，等于给临时状态派了个语义色，而它还是命令面板
 * 与菜单的全局强调色，改动波及整个应用。
 */
const ITEM = cn(
  'group relative flex',
  'min-h-7 px-2 text-xs',
  'cursor-default select-none',
  'items-center gap-2',
  'rounded-[5px]',
  'outline-none',
  'transition-colors',
  'data-[highlighted]:bg-[var(--ui-popup-highlight)]',
  'data-[highlighted]:text-[var(--ui-foreground)]',
  'data-[disabled]:pointer-events-none',
  'data-[disabled]:opacity-50',
)

/*
 * 弹出层宽度自适应内容，锚点宽度只是下限。
 *
 * 下限来自 Base UI Positioner 暴露的 --anchor-width，不由 React 读 offsetWidth
 * 再 setState：那既在 commit 阶段强制同步布局，又在窗口尺寸、字号与文案长度变化
 * 后不会更新。上限与设置页 .settings-select-trigger 同数：面板的水平范围由锚点
 * 决定，不由内容随意撑开，否则勾号被推到很远。
 */
const POPUP_MIN_INLINE_SIZE = '168px'

const POPUP_MAX_INLINE_SIZE = '220px'

/**
 * Select is intended for finite, non-searchable option sets.
 * 选项表由 data 一处供给，Select.Value 依据 { value, label } 取标签，无需重复指定。
 */
export function Select<TValue extends string = string>({
  data,
  type,
  value,
  align = 'start',
  className,
  id,
  onValueChange,
}: SelectProps<TValue>) {
  return (
    <BaseSelect.Root<TValue>
      items={data}
      onValueChange={(nextValue) => {
        if (nextValue !== null) {
          onValueChange(nextValue)
        }
      }}
      value={value || null}
    >
      <BaseSelect.Trigger
        aria-label={type}
        className={cn(TRIGGER, className)}
        id={id}
        type="button"
      >
        {/*
         * 触发器自己渲染选中的那一项，不用 Value 的 placeholder：icon 与文案要一起
         * 画，而 placeholder 只认一段文字。占位走同一个盒子，因此与选中的样子同宽。
         */}
        <BaseSelect.Value className={TRIGGER_VALUE}>
          {(value: unknown) => {
            const held = data.find((option) => option.value === value)

            if (held === undefined) {
              return <span className={VALUE}>{`选择${type}…`}</span>
            }

            return (
              <>
                {held.mark === undefined ? null : (
                  <span aria-hidden="true" className={MARK}>
                    {held.mark}
                  </span>
                )}

                <span className={VALUE}>{held.label}</span>
              </>
            )
          }}
        </BaseSelect.Value>

        <BaseSelect.Icon>
          <ChevronDown aria-hidden="true" className={ICON} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        <BaseSelect.Positioner
          align={align}
          alignItemWithTrigger={false}
          className={popupPositionerClassName}
          sideOffset={4}
        >
          <BaseSelect.Popup
            className={cn(popupSurfaceClassName, '[--color-divider:var(--ui-popover-frame)]')}
            style={{
              minInlineSize: `max(var(--anchor-width), ${POPUP_MIN_INLINE_SIZE})`,
              maxInlineSize: POPUP_MAX_INLINE_SIZE,
            }}
          >
            <BaseSelect.List className={LIST}>
              {data.map((option) => (
                <BaseSelect.Item className={ITEM} key={option.value} value={option.value}>
                  {option.mark === undefined ? null : (
                    <span aria-hidden="true" className={MARK}>
                      {option.mark}
                    </span>
                  )}

                  <BaseSelect.ItemText className={VALUE}>{option.label}</BaseSelect.ItemText>

                  <BaseSelect.ItemIndicator className="ml-auto shrink-0">
                    <Check aria-hidden="true" className="size-4" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
