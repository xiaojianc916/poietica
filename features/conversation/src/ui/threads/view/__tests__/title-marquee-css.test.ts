import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* 会话行标题的悬停横移：爬行由 title-marquee.ts 逐帧写 scrollLeft，样式表只负责
 * 「悬停时摘省略号」与两端渐隐。happy-dom 没有布局，横移本身由同目录的
 * title-marquee.test.tsx 钉住；这里读样式表文本，钉住一改就退回硬裁断的几条规则。 */

const CSS = readFileSync(fileURLToPath(new URL('../assistant-threads.css', import.meta.url)), 'utf8')

interface Rule {
  readonly selector: string
  readonly body: string
}

/**
 * 剥注释后只取**最内层**的声明块：@media 里的规则也在这里面，而 @media 自己的块
 * （体内还有花括号）不会被当成规则。注释先剥掉，注释里的花括号才不会算错块界。
 */
function rulesOf(text: string): Rule[] {
  const stripped = text.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
  const rules: Rule[] = []

  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = match[1]?.trim()
    const body = match[2]

    if (selector === undefined || body === undefined) {
      continue
    }

    rules.push({ selector, body })
  }

  return rules
}

const RULES = rulesOf(CSS)

/** 写在指定选择器里的那条声明；出现多次取最后一条（CSS 的覆盖规则）。 */
function declaredValue(selector: string, property: string): string | undefined {
  let value: string | undefined

  for (const rule of RULES) {
    if (!rule.selector.split(',').some((part) => part.trim() === selector)) {
      continue
    }

    for (const declaration of rule.body.split(';')) {
      const [name, ...rest] = declaration.split(':')

      if (name?.trim() === property) {
        value = rest.join(':').trim()
      }
    }
  }

  return value
}

/** 选择器出现过即可：悬停规则住在 @media (hover: hover) 里，上面的解析已把内层规则摊平。 */
function hasSelector(selector: string): boolean {
  return RULES.some((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
}

describe('会话行的悬停横移（样式护栏）', () => {
  test('静息是省略号，悬停时摘掉省略号：远端那个字会被 … 盖住', () => {
    expect(declaredValue('.assistant-thread__title', 'text-overflow')).toBe('ellipsis')
    expect(declaredValue('.assistant-thread__title', 'overflow')).toBe('hidden')
    /* 悬停那一档写在 @media (hover: hover) 里：块被拍平后选择器仍是这一条。 */
    expect(hasSelector('.assistant-thread:hover .assistant-thread__title')).toBe(true)
    expect(declaredValue('.assistant-thread:hover .assistant-thread__title', 'text-overflow')).toBe('clip')
    expect(declaredValue('.assistant-thread:hover .assistant-thread__title-base', 'text-overflow')).toBe('clip')
  })

  test('两端渐隐各 12px：离开开头才有左端，右边还有字才有右端', () => {
    const left = 'linear-gradient(to right, transparent, #000 12px)'
    const right = 'linear-gradient(to left, transparent, #000 12px)'
    const both = 'linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent)'

    for (const scope of ['.assistant-thread__title', '.assistant-thread__title-base']) {
      expect(declaredValue(`${scope}[data-scrolled]`, 'mask-image')).toBe(left)
      expect(declaredValue(`${scope}[data-clipped]`, 'mask-image')).toBe(right)
      expect(declaredValue(`${scope}[data-scrolled][data-clipped]`, 'mask-image')).toBe(both)
    }
  })

  test('样式表自己不写 scroll-behavior：横移是逐帧赋值，补间会让每一帧都变成缓动', () => {
    expect(declaredValue('.assistant-thread__title', 'scroll-behavior')).toBeUndefined()
  })
})
