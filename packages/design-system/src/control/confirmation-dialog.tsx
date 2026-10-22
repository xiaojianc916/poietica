import { Button } from './button'
import { Dialog } from './dialog'
import './confirmation-dialog.css'

/*
 * 确认框，几何照 zcode 的 AlertDialog（packages/ui/src/components/ui/alert-dialog.tsx）与
 * ConfirmDialog（packages/ui/src/ConfirmDialog.tsx）的组合：
 *
 *   卡     圆角 16、无边框、popover/98 底、内边距 20、块间距 20、上限 28rem；存在感由
 *          一级 elevation（--ui-shadow-xl，对应 zcode 的 shadow-2xl）给
 *   标题   16 / 600
 *   说明   14 / 24、次要字色、保留换行
 *   页脚   右对齐、按钮间距 8，取消在前、确认在后
 *
 * 确认是这一步唯一要做的事，所以不给右上角关闭钮：取消走页脚那颗按钮、Escape 与（非 busy 时的）
 * 遮罩。按钮高读 controls 令牌的 36，与 zcode 的 h-9 同一档。
 */
const DIALOG_CLASS_NAME = [
  'max-w-md',
  'gap-5',
  'border-0',
  'bg-popover/98',
  'p-5',
  'shadow-[var(--ui-shadow-xl)]',
].join(' ')

const TITLE_CLASS_NAME = 'text-base font-semibold'

/* 标题与说明之间 10：zcode 的 AlertDialog 是表头 gap-2 + 说明 pt-0.5。 */
const DESCRIPTION_CLASS_NAME = 'mt-[10px] whitespace-pre-line leading-6'

const FOOTER_CLASS_NAME = 'justify-end gap-2'

/* 两颗键比通用按钮更圆、去投影：确认框本身就是浮起的一层，卡里的选择不该再各自抬一层。 */
const BUTTON_CLASS_NAME = 'rounded-lg shadow-none'

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
 * Confirmation is explicit through the two footer actions, so this composition intentionally has no
 * redundant close icon. Cancellation remains available through the secondary button, Escape, and
 * (when not busy) the light backdrop.
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
      descriptionClassName={DESCRIPTION_CLASS_NAME}
      footer={
        <>
          <Button className={BUTTON_CLASS_NAME} disabled={busy} onClick={onCancel} type="button" variant="secondary">
            {cancelLabel}
          </Button>

          <Button
            aria-busy={busy || undefined}
            className={destructive ? `${BUTTON_CLASS_NAME} confirmation-dialog__destructive` : BUTTON_CLASS_NAME}
            disabled={busy}
            onClick={onConfirm}
            type="button"
            variant={destructive ? 'destructive' : 'default'}
          >
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </>
      }
      footerClassName={FOOTER_CLASS_NAME}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel()
        }
      }}
      open={open}
      showCloseButton={false}
      title={title}
      titleClassName={TITLE_CLASS_NAME}
    />
  )
}
