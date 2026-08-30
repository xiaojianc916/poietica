import { Button } from './button'
import { Dialog } from './dialog'

/*
 * 定值就写成模块常量。
 *
 * 此前页脚那串类名是一个零参数函数：没有入参、返回定值，却每次渲染都 join
 * 一遍拼出同一个字符串；对话框自身那串是行内数组字面量，每次渲染新建一个
 * 数组再 join。本目录既有的形制是模块常量（itemClassName / popupClassName / BASE）。
 */
const DIALOG_CLASS_NAME = [
  '!max-w-[26rem]',
  '!border-b-2 !border-b-foreground/20',
  '!shadow-[0_14px_30px_-22px_rgb(15_23_42_/_0.35)]',
].join(' ')

const FOOTER_CLASS_NAME = 'flex flex-wrap justify-end gap-2.5'

export interface ConfirmationDialogProps {
  readonly open: boolean
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly cancelLabel?: string
  readonly destructive?: boolean
  readonly busy?: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/**
 * A compact, decision-focused dialog.
 *
 * Confirmation is explicit through the two footer actions, so this composition
 * intentionally has no redundant close icon. Cancellation remains available
 * through the outlined button, Escape, and (when not busy) the light backdrop.
 */
export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  return (
    <Dialog
      busy={busy}
      className={DIALOG_CLASS_NAME}
      closeOnOverlayClick={!busy}
      description={description}
      footer={
        <div className={FOOTER_CLASS_NAME}>
          <Button
            className="bg-accent/55 px-3 hover:bg-accent"
            disabled={busy}
            onClick={onCancel}
            type="button"
            variant="ghost"
          >
            {cancelLabel}
          </Button>

          <Button
            aria-busy={busy || undefined}
            disabled={busy}
            onClick={onConfirm}
            type="button"
            variant={destructive ? 'destructive' : 'default'}
          >
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </div>
      }
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel()
        }
      }}
      open={open}
      showCloseButton={false}
      title={title}
    />
  )
}
