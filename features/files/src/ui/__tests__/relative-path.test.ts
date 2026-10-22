import { describe, expect, test } from 'bun:test'
import { joinPath, parentDirectory } from '../relative-path'

describe('relative-path', () => {
  test('parentDirectory / joinPath：Markdown 里的相对链接按那份文件所在的目录拼', () => {
    expect(parentDirectory('docs/guide/a.md')).toBe('docs/guide')
    expect(parentDirectory('a.md')).toBe('')
    expect(joinPath('docs/guide', './img/x.png')).toBe('docs/guide/img/x.png')
    expect(joinPath('docs/guide', '../api.md')).toBe('docs/api.md')
    expect(joinPath('', 'a\\b.md')).toBe('a/b.md')
    /* 拼出根外的 `..` 在这里只是被吃掉：真正的边界在 Core（files.locate 会拒绝越界）。 */
    expect(joinPath('docs', '../../x.md')).toBe('x.md')
  })
})
