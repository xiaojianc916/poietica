import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../class-names'
import { useOverlayRef } from '../overlay-presence'
import './menu.css'
import { menuCardClassName, popupPositionerClassName, popupSurfaceClassName } from './popup-surface'

/** 类型参数保留选项值的字面量联合，避免调用点转换形状或断言类型。 */
export interface SelectOption<TValue extends string = string> {
  readonly value: TValue
  readonly label: string
  /**
   * 行首图标。
   *
   * 名字彼此只差一个序号时（字段列表就是「字段 1」「字段 2」），图标是唯一一眼能分出种类的
   * 东西。触发器与清单画同一份。
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
 * 触发器照 zcode 的 SelectTrigger 默认档（variant=input, size=default）：
 *   h-7 rounded-md pl-2 pr-1 text-ui-base/relaxed
 *   底 bg-input（--color-input-surface），框 --color-input-border、悬停 --color-input-border-hover
 *   （两支走 control/menu.css 的无层规则），聚焦换 --color-input-focused
 *   箭头 [&_svg]:size-3.5
 * 尺寸与字色一律用同一支输入框令牌，触发器因此与同一排的输入框同高同底。
 *
 * cn 靠后的类覆盖靠前的冲突类，调用点的 className 因此排在最后。
 */
const TRIGGER = cn(
  'flex w-fit items-center justify-between gap-1.5',
  'border whitespace-nowrap',
  'text-left text-foreground',
  'outline-none',
  /*
   * zcode 的 transition-colors（只过渡颜色）。本仓原先过渡的是
   * border-color/box-shadow/background-color —— box-shadow 会在每次进入时触发一次额外的绘制，
   * 而这里根本不画阴影。
   */
  'transition-colors',
  'focus-visible:ring-0',
  'focus-visible:bg-[var(--ui-input-focused)]',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'h-7 max-w-full rounded-md pl-2 pr-1 text-sm leading-relaxed',
  /*
   * 框色不在这里给：`* { border-color: var(--ui-divider) }` 是无层规则，压得过 utilities。
   * 这里只挂 ds-select-trigger，框色由 control/menu.css 里那条无层规则统一声明。
   */
  'ds-select-trigger',
  'bg-[var(--ui-input-surface)]',
)

/*
 * 文字那一格只做省略号，不挂 truncate：truncate 带 overflow:hidden，会把同一 flex 行里的箭头
 * 一起裁掉（截图里箭头只露出一半就是这么来的）。省略号交给 text-overflow + whitespace-nowrap。
 */
const VALUE = cn('min-w-0 flex-1', 'overflow-hidden text-ellipsis whitespace-nowrap')

const TRIGGER_VALUE = cn('flex min-w-0 flex-1', 'items-center gap-1.5')

const MARK = cn('flex shrink-0', 'items-center', 'text-muted-foreground')

/*
 * ChevronDown 而不是 ChevronsUpDown：双向箭头说的是「有一根轴能上下走」，那是步进器与可搜索
 * 输入的记号。这里是有限离散值的弹出菜单，说的是「下面会展开一张列表」。
 */
const ICON = cn('size-3.5', 'shrink-0', 'text-muted-foreground')

/*
 * 列表这一层不再自己给内边距：卡的 p-1 已经给过（menuCardClassName），再补一层会让面板比菜单
 * 多缩进 4px。行间那 2px 留给卡面的 gap-0.5，列表只负责滚动与上限。
 */
const LIST = cn('max-h-64', 'overflow-y-auto', 'overscroll-contain', 'outline-none', 'grid gap-0.5')

/*
 * 最小 28 高、圆角 6、内边距 4/8、字 14/1.625。
 *
 * 高亮是中性的：勾号说「当前生效的值」，高亮说「指针或键盘现在指着谁」。用它 --ui-accent 那一档，
 * 与菜单行同一个产地。
 */
const ITEM = cn(
  'group relative flex',
  'min-h-7 w-full px-2 py-1 text-sm leading-relaxed',
  'cursor-default select-none',
  'items-center gap-2',
  'rounded-sm',
  'outline-none',
  'data-[highlighted]:bg-menu-hover',
  'data-[highlighted]:text-foreground',
  'data-[disabled]:pointer-events-none',
  'data-[disabled]:opacity-50',
)

/*
 * 弹出层宽度自适应内容，锚点宽度只是下限。
 *
 * 下限来自 Base UI Positioner 暴露的 --anchor-width，不由 React 读 offsetWidth 再 setState：
 * 那既在 commit 阶段强制同步布局，又在窗口尺寸、字号与文案长度变化后不会更新。上限与设置页
 * .settings-select-trigger 同数：面板的水平范围由锚点决定，否则勾号被推到很远。
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
  const overlayRef = useOverlayRef<HTMLDivElement>('anchored')

  return (
    <BaseSelect.Root<TValue>
      items={data}
      onValueChange={(nextValue) => {
        if (nextValue !== null) {
          onValueChange(nextValue)
        }
      }}
      /*
       * 只把 null / undefined 折成「没有选中」，'' 原样交下去：空串是**我们自己**的一个合法
       * 取值（如 sharpshooter.model 的「自动」档，写回 agent 的就是 ''）。写成 `value || null`
       * 会把它一起吞掉，那一档永远显示成占位符。
       */
      value={value ?? null}
    >
      <BaseSelect.Trigger aria-label={type} className={cn(TRIGGER, className)} id={id} type="button">
        {/*
         * 触发器自己渲染选中的那一项，不用 Value 的 placeholder：icon 与文案要一起画，而
         * placeholder 只认一段文字。占位走同一个盒子，因此与选中的样子同宽。
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
          {/*
           * 与 DropdownMenu 戴同一组卡面类（menuCardClassName 里的 ds-menu-card 是边框色与两个行
           * 变体的挂点）：只戴 popupSurfaceClassName 的话，边框色会落回全局
           * `* { border-color: var(--ui-divider) }`，同一个应用里就出现两种菜单框。
           */}
          <BaseSelect.Popup
            className={cn(popupSurfaceClassName, menuCardClassName)}
            ref={overlayRef}
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
                    <Check aria-hidden="true" />
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
