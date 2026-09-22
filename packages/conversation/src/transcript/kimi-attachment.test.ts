import { describe, expect, test } from 'bun:test'
import { withoutKimiAttachmentNotices } from './kimi-attachment'

/*
 * 摘除判据的回归：参考 web UI 与 kap-server 的实际拼法。
 * 文件名是用户起的，含引号或换行都要摘得掉 —— 摘不掉就是那句话留在气泡里、
 * 文件卡片同时消失（ADR 0050 的缺陷 1）。
 */
describe('kimi attachment notices', () => {
  const notice = (name: string) =>
    `Attached file "${name}" (text/plain, 22 bytes): ` +
    `C:\\Users\\someone\\attachments\\ab\\abc — open it with the Read tool`

  test('a plain notice is removed and the typed words survive', () => {
    expect(withoutKimiAttachmentNotices(`看一下${notice('notes.txt')}`)).toBe('看一下')
  })

  test('a filename containing a quote is still removed', () => {
    expect(withoutKimiAttachmentNotices(notice('we"ird.txt'))).toBe('')
  })

  test('a filename containing a newline is still removed', () => {
    expect(withoutKimiAttachmentNotices(notice('two\nlines.txt'))).toBe('')
  })

  test('several notices in one prompt all go', () => {
    const both = `${notice('a.txt')}${notice('b.txt')}`
    expect(withoutKimiAttachmentNotices(both)).toBe('')
  })

  test('an image compression note is removed', () => {
    const said =
      'what is this<system>Image compressed to fit model limits: 4000x3000 → 1568x1176</system>'
    expect(withoutKimiAttachmentNotices(said)).toBe('what is this')
  })

  test('an omitted-image note is removed', () => {
    expect(withoutKimiAttachmentNotices('look[Image omitted: unsupported format]')).toBe('look')
  })

  test('a prompt with no notice is returned unchanged', () => {
    expect(withoutKimiAttachmentNotices('just words')).toBe('just words')
  })

  test('the words around a notice are kept', () => {
    expect(withoutKimiAttachmentNotices(`before ${notice('x.txt')} after`)).toBe('before  after')
  })
})
