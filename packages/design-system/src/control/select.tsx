import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../class-names'
import { popupPositionerClassName, popupSurfaceClassName } from './popup-surface'

/**
 * 一项可选值。
 *
 * 类型参数让调用点把「这张表里只可能出现这几个字面量」说出来。设置页的颜色模式
 * 与语言各自是一个闭合联合，此前它们为了保住这个约束，只能声明成 [value, label]
 * 元组数组，再在渲染期转成这个形状 —— 同一份数据两种形状，转换每帧一次，末端还
 * 要一次 as 断言把类型接回去。有了参数，元组那一份就没有存在的理由。
 */
export interface SelectOption<TValue extends string = string> {
  readonly value: TValue
  readonly label: string
}

export interface SelectProps<TValue extends string = string> {
  /** 全部可选值。触发器上的标签与列表里的行都由它渲染，只有这一个产地。 */
  readonly data: readonly SelectOption<TValue>[]
  /**
   * 这个下拉在选什么。
   *
   * 一处声明，两处使用：占位文案是「选择{type}…」，触发器的可访问名也是它。此前
   * 两个调用点都把同一个串分别喂给 type 与 aria-label 两个入口，没有任何东西保证
   * 它们一致 —— 那不是两件事，是一件事被写了两遍。
   */
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
 * 触发器只有一种形制。
 *
 * 此前这里是两张按档位与色调索引的表（sm|md × outline|plain），而全仓两个调用点
 * 都写 size="sm" tone="plain" —— md 与 outline 这两个默认值一次都没有被取到。一个
 * 从不切换的开关不是可配置性，是一条走不到的分支。它还带着连带成本：档位要在
 * render 期间同时到达触发器、面板与每一行，于是这个文件养了一个 React context，
 * 外加一个 useMemo 和一句「必须渲染在 Select 里」的运行时抛错。档位收成常量、
 * 组合结构收回来之后，那套东西一起没有了内容。
 *
 * 参数顺序照旧：cn 靠后的类在 Tailwind 冲突时压过靠前的，调用点传进来的
 * className 仍然排在最后。
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
  'w-auto max-w-full rounded-lg border-0 bg-transparent shadow-none hover:bg-accent data-[popup-open]:bg-accent',
)

const VALUE = cn('min-w-0 flex-1', 'truncate')

/*
 * ChevronDown 而不是 ChevronsUpDown：双向箭头说的是「有一根轴能上下走」，那是
 * 步进器与可搜索输入的记号。这里是有限离散值的弹出菜单，说的是「下面会展开一
 * 张列表」。
 */
const ICON = cn('size-3.5', 'shrink-0', 'text-muted-foreground')

/*
 * 列表与分组合成一层。
 *
 * Base UI 的 Select.Group 是给带组标题的分组用的（配 Select.GroupLabel）。两个
 * 调用点都只有一个组、都不带标题 —— 那不是分组，是一层只为了挂 gap 而存在的
 * div。间距落到列表本身，DOM 少一层，视觉不变。
 */
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
 *
 * 触发器、面板与每一行都在这里，不对外拆开：全仓两个调用点写出的是同一棵树，
 * 而各自把它包了一层同名同参的包装 —— 那正是把组合权交出去的代价。选项表由
 * data 一处供给，Select.Value 依据 { value, label } 自动取标签（官方行为，不必
 * 写 itemToStringLabel）。
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
        <BaseSelect.Value className={VALUE} placeholder={`选择${type}…`} />

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
            className={popupSurfaceClassName}
            style={{
              minInlineSize: `max(var(--anchor-width), ${POPUP_MIN_INLINE_SIZE})`,
              maxInlineSize: POPUP_MAX_INLINE_SIZE,
            }}
          >
            <BaseSelect.List className={LIST}>
              {data.map((option) => (
                <BaseSelect.Item className={ITEM} key={option.value} value={option.value}>
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
