import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ProseFileLinksContext } from '../file-links-context'
import { type FileRef, fileHrefOf, fileRefOfCode, fileRefOfHref, fileRefOfTarget } from '../file-ref'
import { Prose } from '../prose'

afterEach(() => {
  cleanup()
})

const ref = (path: string, line: number | null = null, column: number | null = null): FileRef => ({
  path,
  line,
  column,
})

describe('文件引用：链接目标', () => {
  test('Windows / UNC / POSIX / file: / 相对路径都认，网页与锚点不认', () => {
    expect(fileRefOfTarget('C:\\Users\\x\\a.md')).toEqual(ref('C:\\Users\\x\\a.md'))
    expect(fileRefOfTarget('C:/Users/x/a.md')).toEqual(ref('C:/Users/x/a.md'))
    expect(fileRefOfTarget('\\\\server\\share\\a.md')).toEqual(ref('\\\\server\\share\\a.md'))
    expect(fileRefOfTarget('/home/x/c.md')).toEqual(ref('/home/x/c.md'))
    expect(fileRefOfTarget('file:///C:/Users/x/my%20file.ts')).toEqual(ref('C:/Users/x/my file.ts'))
    expect(fileRefOfTarget('file:///home/x/a.ts')).toEqual(ref('/home/x/a.ts'))
    expect(fileRefOfTarget('<C:\\Users\\x\\my file.ts>')).toEqual(ref('C:\\Users\\x\\my file.ts'))
    expect(fileRefOfTarget('src/e.ts')).toEqual(ref('src/e.ts'))
    expect(fileRefOfTarget('https://example.com/a.ts')).toBeNull()
    expect(fileRefOfTarget('mailto:a@b.c')).toBeNull()
    expect(fileRefOfTarget('#heading')).toBeNull()
    expect(fileRefOfTarget('//cdn.example.com/x.js')).toBeNull()
  })

  test('行号：#L12、#L12C5、#L3-L9、:12、:12:5；盘符不被当成行号', () => {
    expect(fileRefOfTarget('src/a.ts#L12')).toEqual(ref('src/a.ts', 12))
    expect(fileRefOfTarget('src/a.ts#L12C5')).toEqual(ref('src/a.ts', 12, 5))
    expect(fileRefOfTarget('src/a.ts#L3-L9')).toEqual(ref('src/a.ts', 3))
    expect(fileRefOfTarget('C:\\r\\a.ts:12')).toEqual(ref('C:\\r\\a.ts', 12))
    expect(fileRefOfTarget('C:\\r\\a.ts:12:5')).toEqual(ref('C:\\r\\a.ts', 12, 5))
  })

  test('地址往返：编码之后原样解回来，带出处', () => {
    const href = fileHrefOf(ref('C:\\r\\my file#1.ts', 7), 'code')
    expect(href.startsWith('poietica-file:')).toBe(true)
    expect(fileRefOfHref(href)).toEqual({ ref: ref('C:\\r\\my file#1.ts', 7), origin: 'code' })
  })
})

describe('文件引用：行内代码', () => {
  test('带目录且认得出的文件名、裸的知名文件名才算', () => {
    expect(fileRefOfCode('src/ui/review-pane.tsx')).toEqual(ref('src/ui/review-pane.tsx'))
    expect(fileRefOfCode('src/a.ts:42')).toEqual(ref('src/a.ts', 42))
    expect(fileRefOfCode('C:\\Program Files\\x\\a.json')).toEqual(ref('C:\\Program Files\\x\\a.json'))
    expect(fileRefOfCode('package.json')).toEqual(ref('package.json'))
    expect(fileRefOfCode('Dockerfile')).toEqual(ref('Dockerfile'))
  })

  test('代码片段、成员访问、网址、无扩展名的目录不算', () => {
    expect(fileRefOfCode('console.log')).toBeNull()
    expect(fileRefOfCode('process.env')).toBeNull()
    expect(fileRefOfCode('a / b')).toBeNull()
    expect(fileRefOfCode('src/components')).toBeNull()
    expect(fileRefOfCode('https://x.dev/a.ts')).toBeNull()
    expect(fileRefOfCode('const x = 1')).toBeNull()
    expect(fileRefOfCode('foo(bar)')).toBeNull()
  })
})

describe('正文渲染', () => {
  const text = [
    '改了 [review-pane.tsx](C:\\repo\\.github\\_x\\review-pane.tsx) 与 [说明](docs/a.md#L3)。',
    '',
    '另见 `src/ui/b.ts:9`，以及 [官网](https://example.com)。',
  ].join('\n')

  test('有宿主：点了交出原文路径（反斜杠转义不被吃掉）与行号', () => {
    const opened: FileRef[] = []
    const { container } = render(
      <ProseFileLinksContext value={{ open: (held) => opened.push(held) }}>
        <Prose text={text} />
      </ProseFileLinksContext>,
    )
    const links = [...container.querySelectorAll('a[data-file-ref]')]
    expect(links.map((link) => link.textContent)).toEqual(['review-pane.tsx', '说明', 'src/ui/b.ts:9'])
    expect(container.textContent).not.toContain('[blocked]')
    for (const link of links) fireEvent.click(link)
    expect(opened).toEqual([ref('C:\\repo\\.github\\_x\\review-pane.tsx'), ref('docs/a.md', 3), ref('src/ui/b.ts', 9)])
    const web = container.querySelector('a[href="https://example.com/"], a[href="https://example.com"]')
    expect(web?.getAttribute('target')).toBe('_blank')
  })

  test('没有宿主：链接画成不可点的文件名，行内代码原样是代码', () => {
    const { container } = render(<Prose text={text} />)
    expect(container.querySelector('a[data-file-ref]')).toBeNull()
    expect(container.textContent).not.toContain('[blocked]')
    const inert = [...container.querySelectorAll('.prose-file-link[data-inert]')]
    expect(inert.map((node) => node.textContent)).toEqual(['review-pane.tsx', '说明'])
    expect(container.querySelector('code')?.textContent).toBe('src/ui/b.ts:9')
  })
})
