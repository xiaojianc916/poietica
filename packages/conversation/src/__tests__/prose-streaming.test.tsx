import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Prose } from '../timeline/prose'

describe('流式正文', () => {
  it('只在活跃尾项上启用渐进呈现', () => {
    const live = renderToStaticMarkup(<Prose streaming text="one two" />)
    const settled = renderToStaticMarkup(<Prose text="one two" />)

    expect(live).toContain('data-sd-animate')
    expect(settled).not.toContain('data-sd-animate')
  })
})
