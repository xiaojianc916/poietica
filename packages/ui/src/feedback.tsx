import { CircleAlert as DangerCircle, LoaderCircle as Spinner } from 'lucide-react'
import { Button } from './button'

/*
 * 行内忙碌指示：一次真实往返还没回来时显示在动作按钮旁边。
 *
 * 与 LoadingState 共用同一个字形，因为「转圈」只该有一处定义。LoadingState 自己是块级的
 * （min-h-32 的居中栅格），塞不进按钮那一行 —— 缺了这一格，调用方就会各自手画一个 SVG。
 *
 * 它没有「停下来」的语义：动画在不在，等于那次调用回没回来。调用方不得为了好看提前拿掉它。
 */
export function InlineSpinner() {
  return <Spinner aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
}

export function LoadingState({ label = '正在加载…' }: { readonly label?: string }) {
  return (
    <div className="grid min-h-32 place-items-center text-sm text-muted-foreground" role="status">
      <span className="flex items-center gap-2">
        <InlineSpinner />
        {label}
      </span>
    </div>
  )
}

export function ErrorState({
  title = '暂时无法完成操作',
  message,
  onRetry,
}: {
  readonly title?: string
  readonly message: string
  readonly onRetry?: () => void
}) {
  return (
    <section className="grid min-h-40 place-items-center px-6 text-center" role="alert">
      <div>
        <DangerCircle aria-hidden="true" className="mx-auto size-8 text-destructive" />

        <h3 className="mt-3 text-sm font-semibold">{title}</h3>

        <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{message}</p>

        {onRetry ? (
          <Button className="mt-4" onClick={onRetry} size="sm" type="button" variant="outline">
            重试
          </Button>
        ) : null}
      </div>
    </section>
  )
}
