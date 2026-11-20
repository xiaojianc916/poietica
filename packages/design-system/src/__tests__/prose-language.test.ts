import { expect, test } from 'bun:test'
import type { Root } from 'hast'
import { rehypeTextLanguage } from '../prose/language'

function treeOf(children: Root['children']): Root {
  return { type: 'root', children }
}

test('段落按汉字占比标语言：中文 zh-CN，英文 en，纯数字不标', () => {
  const tree = treeOf([
    {
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{ type: 'text', value: '这是中文段落，带一点 English。' }],
    },
    {
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{ type: 'text', value: 'This paragraph is mostly English with 一个词。' }],
    },
    {
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{ type: 'text', value: '1234 5678' }],
    },
  ])

  rehypeTextLanguage()(tree)

  const [zh, en, numeric] = tree.children
  expect(zh?.type === 'element' ? zh.properties.lang : undefined).toBe('zh-CN')
  expect(en?.type === 'element' ? en.properties.lang : undefined).toBe('en')
  expect(numeric?.type === 'element' ? numeric.properties.lang : undefined).toBeUndefined()
})
