import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 滚动条的复刻契约。
 *
 * 这一条样式是对 DeepSeek Harness 的逐值复刻（正本：装机版
 * `@deepseek-ai/dsh-client-ui-theme` 的 `src/styles/scrollbar.css`，2026-10-09 提取）。
 * 「逐值」这件事没有任何运行时能替我们盯着：CSS 写错了不报错，只是屏幕上多了几个像素，
 * 而这份文件被后来者「顺手调一下」的概率极高。所以这里把正本的数值钉成文本契约。
 *
 * 不测渲染：伪元素没法用 getComputedStyle 读，本仓也没有真 DOM 测试基建。
 */

const here = dirname(fileURLToPath(import.meta.url))
const stylesheet = readFileSync(join(here, '..', 'scrollbar.css'), 'utf8')

/** 取一条自定义属性的全部声明值。 */
const tokenValues = (name: string) =>
  [...stylesheet.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'gu'))].map((match) => match[1]?.trim())

/** 选择器里的正则元字符只有 . 与 *，其余（含 ::）在正则里本义。 */
const literal = (selector: string) => selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** 取某个伪元素选择器的规则体。 */
const ruleBody = (selector: string) => {
  const body = new RegExp(`${literal(selector)}\\s*\\{([^}]*)\\}`, 'u').exec(stylesheet)?.[1]

  if (body === undefined) {
    throw new Error(`${selector} 应当有一条规则`)
  }

  return body
}

describe('滚动条的 Harness 复刻契约', () => {
  it('槽宽只有一处真身:5px', () => {
    expect(tokenValues('--ui-scrollbar-size')).toEqual(['5px'])
  })

  it('取色是正本的实色:浅色一对、深色一对', () => {
    /* 深色常态是产品指定的 #2b2b2b，不是正本那档 #3c3c3d（悬停仍是正本值）。 */
    expect(tokenValues('--ui-scrollbar-thumb')).toEqual(['#e5e5e5', '#2b2b2b'])
    expect(tokenValues('--ui-scrollbar-thumb-hover')).toEqual(['#d4d4d4', '#545557'])
  })

  it('深色那一对落在 data-theme="dark" 的根上', () => {
    /* 两处覆盖必须紧跟深色根选择器；写在别处就等于深色下用浅色的灰。 */
    expect(stylesheet).toContain(':root[data-theme="dark"] {')
    expect(stylesheet).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--ui-scrollbar-thumb:\s*#2b2b2b;/u)
    expect(stylesheet).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--ui-scrollbar-thumb-hover:\s*#545557;/u)
  })

  it('几何照抄正本:滑块铺满槽、圆角 999px、轨道与四角透明', () => {
    expect(tokenValues('--ui-scrollbar-thumb-border')).toEqual(['0px'])
    expect(tokenValues('--ui-scrollbar-track-margin')).toEqual(['0px'])

    const thumb = ruleBody('::-webkit-scrollbar-thumb')

    expect(thumb).toContain('border-radius: 999px')
    expect(thumb).toContain('corner-shape: round')
    expect(thumb).toContain('background-clip: content-box')
    expect(thumb).toContain('background: var(--ui-scrollbar-thumb)')

    expect(ruleBody('::-webkit-scrollbar-track')).toContain('background: transparent')
    expect(ruleBody('::-webkit-scrollbar-corner')).toContain('background: transparent')
    expect(ruleBody('::-webkit-scrollbar-thumb:hover')).toContain('var(--ui-scrollbar-thumb-hover)')
  })

  it('标准属性只活在回退分支里:它们与 ::-webkit-scrollbar 互斥', () => {
    /*
     * Chromium 两套都认，标准属性赢 —— 落在 @supports 之外就是复刻样式整套失效，
     * 屏幕上退回系统那条厚边条。这条断言是那个「外面」的看门人。
     */
    const withoutComments = stylesheet.replaceAll(/\/\*[\S\s]*?\*\//gu, '')
    const withoutFallback = withoutComments.replace(/@supports[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gu, '')

    expect(withoutFallback).not.toContain('scrollbar-color')
    expect(withoutFallback).not.toContain('scrollbar-width')
    expect(stylesheet).toContain('@supports not selector(::-webkit-scrollbar)')
  })
})
