import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { ImageLightbox } from '../image-lightbox'

afterEach(() => {
  cleanup()
})

const IMAGES = [{ src: 'data:image/png;base64,iVBORw0KGgo=', alt: '截图' }]

describe('P-06 灯箱按需加载', () => {
  test('B1 关着的灯箱什么都不挂（不常驻实例）', async () => {
    render(<ImageLightbox images={IMAGES} index={null} onIndexChange={() => undefined} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('.yarl__root, .yarl__portal')).toBeNull()
  })

  test('B2 打开：分块到达后显示灯箱', async () => {
    render(<ImageLightbox images={IMAGES} index={0} onIndexChange={() => undefined} />)
    await waitFor(
      () => {
        expect(document.querySelector('.yarl__portal, .yarl__root')).not.toBeNull()
      },
      { timeout: 5_000 },
    )
  })

  test('B3 关上：实现随即卸掉（库在淡出放完后才回调关闭，所以不会截断动画）', async () => {
    const view = render(<ImageLightbox images={IMAGES} index={0} onIndexChange={() => undefined} />)
    await waitFor(() => {
      expect(document.querySelector('.yarl__portal, .yarl__root')).not.toBeNull()
    })
    view.rerender(<ImageLightbox images={IMAGES} index={null} onIndexChange={() => undefined} />)
    expect(document.querySelector('.yarl__portal, .yarl__root')).toBeNull()
  })
})
