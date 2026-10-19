import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { Dialog } from '../control/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../control/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../control/tooltip'
import {
  type OverlayPresence,
  overlaysOnScreen,
  registerOverlay,
  subscribeOverlays,
  useModalOverlay,
  useOverlayRef,
} from '../overlay-presence'

/* 浮层登记（P-07）：原生视图让不让路全看这里，漏登记一种浮层，它就会被网页盖住。 */

afterEach(() => {
  cleanup()
})

const kinds = (): OverlayPresence['kind'][] => overlaysOnScreen().map((overlay) => overlay.kind)

test('OP1 登记 / 注销都通知订阅者；快照在没有变化时是同一个数组，注销重复调用无害', () => {
  let calls = 0
  const stop = subscribeOverlays(() => {
    calls += 1
  })
  const before = overlaysOnScreen()
  expect(overlaysOnScreen()).toBe(before)

  const unregister = registerOverlay({ kind: 'modal' })
  expect(kinds()).toEqual(['modal'])
  expect(calls).toBe(1)

  unregister()
  unregister()
  expect(overlaysOnScreen()).toEqual([])
  expect(calls).toBe(2)
  stop()
})

function Anchored({ forward }: { readonly forward?: React.Ref<HTMLDivElement> }) {
  return <div ref={useOverlayRef('anchored', forward)}>浮层</div>
}

test('OP2 useOverlayRef：挂上登记（带元素）、卸下注销，并把元素转交给调用方的 ref', () => {
  const forward = createRef<HTMLDivElement>()
  const view = render(<Anchored forward={forward} />)
  const [overlay] = overlaysOnScreen()
  expect(overlay?.kind).toBe('anchored')
  expect(overlay?.kind === 'anchored' ? overlay.element : null).toBe(forward.current)
  expect(forward.current?.textContent).toBe('浮层')

  view.unmount()
  expect(overlaysOnScreen()).toEqual([])
  expect(forward.current).toBeNull()
})

function Lightbox({ open }: { readonly open: boolean }) {
  useModalOverlay(open)
  return null
}

test('OP3 useModalOverlay：active 期间算一层模态浮层', () => {
  const view = render(<Lightbox open={false} />)
  expect(overlaysOnScreen()).toEqual([])
  view.rerender(<Lightbox open />)
  expect(kinds()).toEqual(['modal'])
  view.rerender(<Lightbox open={false} />)
  expect(overlaysOnScreen()).toEqual([])
})

test('OP4 Dialog 打开即登记为模态浮层，卸载即注销', async () => {
  const props = { onOpenChange: () => undefined, title: '确认' }
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<Dialog {...props} open />)
  })
  expect(kinds()).toEqual(['modal'])
  await act(async () => {
    view.unmount()
  })
  expect(overlaysOnScreen()).toEqual([])
})

test('OP5 菜单与提示的弹层登记为贴边浮层，元素就是弹层本身；调用方传的 ref 照样拿得到元素', async () => {
  const popup = createRef<HTMLDivElement>()
  await act(async () => {
    render(
      <TooltipProvider>
        <DropdownMenu open>
          <DropdownMenuTrigger>更多</DropdownMenuTrigger>
          <DropdownMenuContent ref={popup}>
            <DropdownMenuItem>一行</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip open>
          <TooltipTrigger>问号</TooltipTrigger>
          <TooltipContent>说明</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
  })
  const anchored = overlaysOnScreen().flatMap((overlay) => (overlay.kind === 'anchored' ? [overlay.element] : []))
  expect(anchored).toHaveLength(2)
  expect(anchored).toContain(popup.current as Element)
  expect(anchored.some((element) => element.textContent === '说明')).toBe(true)
})
