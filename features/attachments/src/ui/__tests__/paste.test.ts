import { describe, expect, test } from 'bun:test'
import {
  claimsLongText,
  imageFromClipboard,
  markdownOf,
  PASTE_TEXT_ABOVE_LINES,
  pathsFromDrop,
  textFromClipboard,
} from '../paste'

/* 粘贴与拖放的两条取数规则。只测「取什么」，入库那一段走契约方法（在 core 的测试里覆盖）。 */

const item = (kind: string, file: File | null): DataTransferItem =>
  ({ kind, getAsFile: () => file }) as unknown as DataTransferItem

const png = (): File => new File(['x'], 'shot.png', { type: 'image/png' })

describe('剪贴板取数与超长文本判据', () => {
  test('只有图片才算图；没有图、非图片文件、空剪贴板都交回 null（调用方据此不吃掉事件）', () => {
    expect(imageFromClipboard([item('string', null), item('file', png())])?.name).toBe('shot.png')
    expect(imageFromClipboard([item('string', null)])).toBeNull()
    expect(imageFromClipboard([])).toBeNull()

    const txt = new File(['x'], 'a.txt', { type: 'text/plain' })
    expect(imageFromClipboard([item('file', txt)])).toBeNull()
    expect(textFromClipboard(null)).toBe('')
  })

  /*
   * 粘进来的整份文档不进编辑器：超过阈值的纯文本收成一份 .md。判据只看行数，
   * 阈值那一行以内照常是文字，人打的一句话不会被抢走。
   */
  test('阈值那一行以内还是文字，超一行收成一份 markdown 文件', () => {
    const lines = (count: number): string =>
      Array.from({ length: count }, (_, at) => `第 ${String(at + 1)} 行`).join('\n')

    expect(claimsLongText(lines(PASTE_TEXT_ABOVE_LINES))).toBe(false)
    const text = lines(PASTE_TEXT_ABOVE_LINES + 1)
    expect(claimsLongText(text)).toBe(true)

    const { bytes, filename, mime } = markdownOf(text)
    expect(filename).toBe('粘贴的文本.md')
    expect(mime).toBe('text/markdown')
    expect(new TextDecoder().decode(bytes)).toBe(text)
  })
})

describe('拖放取路径', () => {
  test('能拿到路径的文件进列表；拿不到路径（抛错或空串）的跳过', () => {
    const a = new File(['x'], 'a.txt')
    const b = new File(['y'], 'b.txt')
    expect(pathsFromDrop([a, b], (f) => `C:\\tmp\\${f.name}`)).toEqual(['C:\\tmp\\a.txt', 'C:\\tmp\\b.txt'])
    expect(
      pathsFromDrop([a, b], (f) => {
        if (f.name === 'a.txt') throw new Error('no path')
        return 'C:\\tmp\\b.txt'
      }),
    ).toEqual(['C:\\tmp\\b.txt'])
    expect(pathsFromDrop([a], () => '')).toEqual([])
  })
})
