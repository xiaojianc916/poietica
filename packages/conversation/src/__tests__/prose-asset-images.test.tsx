import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Prose } from '../surface/timeline/prose'

/*
 * 助手正文里的图片走资产协议。这条链上有两件事会各自静默失效：协议名从净化
 * 白名单掉了（图变灰 chip），或整条链被换掉时漏了某一环（净化失效）。两个方向
 * 都钉在这里，因为它们都不会让别的测试变红。
 */
const HASH = 'a'.repeat(64)
const ASSET = `poietica-asset://asset/session/${HASH}`

describe('正文里的资产图片', () => {
  it('渲染助手产物用的资产地址', () => {
    const html = renderToStaticMarkup(<Prose text={`![图](${ASSET})`} />)

    expect(html).toContain(`<img`)
    expect(html).toContain(`src="${ASSET}"`)
  })

  it('http(s) 仍然照常', () => {
    const html = renderToStaticMarkup(<Prose text="![图](https://example.com/x.png)" />)

    expect(html).toContain('src="https://example.com/x.png"')
  })

  it('补了协议名不等于放开任意地址', () => {
    for (const src of [
      'data:image/png;base64,iVBORw0KGgo=',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      const html = renderToStaticMarkup(<Prose text={`![图](${src})`} />)

      expect(html).not.toContain('<img')
    }
  })
})
