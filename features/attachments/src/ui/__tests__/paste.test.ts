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

describe('剪贴板取图', () => {
  test('挑出第一张图片', () => {
    const found = imageFromClipboard([item('string', null), item('file', png())])
    expect(found?.name).toBe('shot.png')
  })

  test('没有图就交回 null（调用方据此不吃掉事件）', () => {
    expect(imageFromClipboard([item('string', null)])).toBeNull()
    expect(imageFromClipboard([])).toBeNull()
  })

  test('非图片文件不算（剪贴板里的文本文件不按图入库）', () => {
    const txt = new File(['x'], 'a.txt', { type: 'text/plain' })
    expect(imageFromClipboard([item('file', txt)])).toBeNull()
  })
})

/*
 * 粘进来的整份文档不进编辑器：超过阈值的纯文本收成一份 .md。判据只看行数，
 * 五十行以内照常是文字，人打的一句话不会被抢走。
 */
describe('超长粘贴文本', () => {
  const lines = (count: number): string =>
    Array.from({ length: count }, (_, at) => `第 ${String(at + 1)} 行`).join('\n')

  test('阈值那一行以内还是文字', () => {
    expect(claimsLongText(lines(PASTE_TEXT_ABOVE_LINES))).toBe(false)
    expect(claimsLongText(lines(PASTE_TEXT_ABOVE_LINES + 1))).toBe(true)
  })

  test('空文本不算', () => {
    expect(claimsLongText('')).toBe(false)
  })

  test('收成一份 markdown 文件', () => {
    const text = lines(PASTE_TEXT_ABOVE_LINES + 1)
    const { bytes, filename, mime } = markdownOf(text)

    expect(filename).toBe('粘贴的文本.md')
    expect(mime).toBe('text/markdown')
    expect(new TextDecoder().decode(bytes)).toBe(text)
  })

  test('剪贴板里没有文字就交回空串', () => {
    expect(textFromClipboard(null)).toBe('')
  })
})

describe('拖放取路径', () => {
  test('能拿到路径的文件进列表', () => {
    const a = new File(['x'], 'a.txt')
    const b = new File(['y'], 'b.txt')
    const paths = pathsFromDrop([a, b], (f) => `C:\\tmp\\${f.name}`)
    expect(paths).toEqual(['C:\\tmp\\a.txt', 'C:\\tmp\\b.txt'])
  })

  test('拿不到路径的文件被跳过（从浏览器拖来的图不是本地文件）', () => {
    const a = new File(['x'], 'a.txt')
    const b = new File(['y'], 'b.txt')
    const paths = pathsFromDrop([a, b], (f) => {
      if (f.name === 'a.txt') throw new Error('no path')
      return 'C:\\tmp\\b.txt'
    })
    expect(paths).toEqual(['C:\\tmp\\b.txt'])
  })

  test('路径是空串也算拿不到', () => {
    const a = new File(['x'], 'a.txt')
    expect(pathsFromDrop([a], () => '')).toEqual([])
  })
})
