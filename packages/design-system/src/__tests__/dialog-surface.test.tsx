import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { ConfirmationDialog } from '../control/confirmation-dialog'
import { Dialog } from '../control/dialog'

/*
 * 通用弹窗的表面契约（照 zcode 的 Dialog / AlertDialog）。
 *
 * 这些值是「弹窗长什么样」的全部事实：遮罩浓度、卡面圆角与内边距、块的间距、标题字号。
 * 它们分散在 Base UI 的 Portal 结构里，真机上肉眼能看出不对劲时已经没人记得原值 —— 所以
 * 在这里钉住，改样式必须连带改这份清单。
 */

afterEach(() => {
  cleanup()
})

const renderDialog = async (element: React.ReactElement): Promise<void> => {
  await act(async () => {
    render(element)
  })
}

const popup = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[role="dialog"]')
  if (element === null) throw new Error('对话框没渲染出来')
  return element
}

/** Base UI 的遮罩不进无障碍树，只能按 class 找：全页唯一压着一层浅黑的那层就是它。 */
const backdrop = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('.bg-black\\/24')
  if (element === null) throw new Error('遮罩层没渲染出来')

  return element
}

describe('通用弹窗的表面', () => {
  test('遮罩只压 24% 黑、不模糊', async () => {
    await renderDialog(<Dialog onOpenChange={() => undefined} open title="标题" />)

    const classes = [...backdrop().classList]
    expect(classes).toContain('bg-black/24')
    expect(classes).not.toContain('backdrop-blur-xs')
  })

  test('卡面：圆角 16、1px 描边、popover 底、shadow-md、内边距与块间距都是 16', async () => {
    await renderDialog(<Dialog onOpenChange={() => undefined} open title="标题" />)

    const classes = [...popup().classList]
    expect(classes).toContain('rounded-2xl')
    expect(classes).toContain('border')
    expect(classes).toContain('bg-popover')
    expect(classes).toContain('shadow-md')
    expect(classes).toContain('p-4')
    expect(classes).toContain('gap-4')
  })

  test('标题 14/500，说明 14/1.625 次要字色', async () => {
    await renderDialog(<Dialog description="说明" onOpenChange={() => undefined} open title="标题" />)

    const title = popup().querySelector('h2, [data-slot="title"]') ?? popup().querySelector('[id$="-title"]')
    expect([...(title?.classList ?? [])]).toEqual(expect.arrayContaining(['text-sm', 'font-medium']))

    const description = popup().querySelector('p')
    expect([...(description?.classList ?? [])]).toEqual(
      expect.arrayContaining(['text-sm', 'leading-relaxed', 'text-muted-foreground']),
    )
  })

  test('页脚窄屏竖排、宽屏右对齐；按钮不再各带横向内边距', async () => {
    await renderDialog(
      <Dialog footer={<button type="button">确定</button>} onOpenChange={() => undefined} open title="标题" />,
    )

    const footer = popup().querySelector('footer')
    expect([...(footer?.classList ?? [])]).toEqual(
      expect.arrayContaining(['flex-col-reverse', 'gap-2', 'sm:flex-row', 'sm:justify-end']),
    )

    const header = popup().querySelector('header')
    expect([...(header?.classList ?? [])]).not.toContain('px-5')
  })
})

describe('确认框的表面', () => {
  const confirmation = (destructive = false): React.ReactElement => (
    <ConfirmationDialog
      confirmLabel="删除"
      description="会一并删除运行索引。"
      destructive={destructive}
      onCancel={() => undefined}
      onConfirm={() => undefined}
      open
      title="删除这条自动化？"
    />
  )

  test('无边框 + 20 内边距 + 20 块间距，上限 28rem', async () => {
    await renderDialog(confirmation())

    const classes = [...popup().classList]
    expect(classes).toContain('border-0')
    expect(classes).toContain('p-5')
    expect(classes).toContain('gap-5')
    expect(classes).toContain('max-w-md')
    expect(classes).toContain('bg-popover/98')
  })

  test('标题 16/600；说明保留换行', async () => {
    await renderDialog(confirmation())

    const title = popup().querySelector('h2, [data-slot="title"]') ?? popup().querySelector('[id$="-title"]')
    expect([...(title?.classList ?? [])]).toEqual(expect.arrayContaining(['text-base', 'font-semibold']))

    const description = popup().querySelector('p')
    expect([...(description?.classList ?? [])]).toEqual(expect.arrayContaining(['whitespace-pre-line']))
  })

  test('页脚只有取消与确认两颗按钮，危险动作走 destructive', async () => {
    await renderDialog(confirmation(true))

    const footer = popup().querySelector('footer')
    const labels = [...(footer?.querySelectorAll('button') ?? [])].map((button) => button.textContent)
    expect(labels).toEqual(['取消', '删除'])

    /* 危险键在深色下要换成红墨压底（confirmation-dialog.css），所以它一定戴着那个类。 */
    const confirmButton = footer?.querySelectorAll('button')[1]
    expect(confirmButton?.className).toContain('bg-destructive')
    expect(confirmButton?.className).toContain('confirmation-dialog__destructive')
    expect(popup().querySelector('header button')).toBeNull()
  })
})
