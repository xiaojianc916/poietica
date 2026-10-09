import { describe, expect, test } from 'bun:test'
import { imageFromClipboard, pathsFromDrop } from '../paste'

/*
 * 粘贴与拖放的两条取数规则（07 页 §4E、14 页 §8.5 坑 8）。
 * 只测「取什么」，入库那一段走契约方法（在 core 的测试里覆盖）。
 */

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
