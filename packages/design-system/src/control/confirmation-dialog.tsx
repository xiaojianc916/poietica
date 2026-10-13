import { Button } from './button'
import { Dialog } from './dialog'
import './confirmation-dialog.css'

/*
 * 定值就写成模块常量：这个目录既有的形制是模块常量（itemClassName / popupClassName / BASE），
 * 而不是零参数函数或行内数组字面量 —— 后者每次渲染都重新 join 一遍同一个字符串。
 */
const DIALOG_CLASS_NAME = [
  'confirmation-dialog',
  '!max-w-[26rem]',
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
      description={description}
      footer={
        <div className={FOOTER_CLASS_NAME}>
          <Button
            className="confirmation-dialog__cancel px-3"
            disabled={busy}
            onClick={onCancel}
            type="button"
            variant="ghost"
          >
            {cancelLabel}
          </Button>

          <Button
            aria-busy={busy || undefined}
            className={destructive ? 'confirmation-dialog__destructive' : undefined}
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
