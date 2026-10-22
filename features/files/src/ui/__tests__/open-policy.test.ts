import { describe, expect, test } from 'bun:test'
import { joinPath, opensAsProgram, parentDirectory } from '../open-policy'

describe('open-policy', () => {
  test('可执行类型不放行「用默认应用打开」（不分大小写）', () => {
    expect(opensAsProgram('tools/setup.EXE')).toBe(true)
    expect(opensAsProgram('scripts/build.ps1')).toBe(true)
    expect(opensAsProgram('src/index.js')).toBe(true)
    expect(opensAsProgram('C:\\repo\\run.bat')).toBe(true)
    expect(opensAsProgram('docs/readme.md')).toBe(false)
    expect(opensAsProgram('.bat')).toBe(false)
    expect(opensAsProgram('Makefile')).toBe(false)
  })

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
