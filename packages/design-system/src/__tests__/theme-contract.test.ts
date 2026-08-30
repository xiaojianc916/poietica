import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 一、主题契约完整性。起因：一次用正则替换注释的改动把 --ui-card /
 *     --ui-chrome / --ui-sidebar 等七个 token 连带删掉，设置页分组卡与侧栏
 *     底色变成一片白，而当时的测试只看几个颜色字面值，全绿。
 *
 * 二、两档线的比例不变量：同一张卡内，外框相对基底的对比度是卡内线的
 *     3～6 倍。低于 3 卡片会"化开"成一叠平行线（曾经是 1 倍，后来 2.2 倍，
 *     都不够）。这条是核心，值可以整体升降，比例不许塌。
 *
 *     这里曾经还有一条"外框必须比窗格分隔线重"，已删除：窗格线是整屏宽的
 *     区域边界，卡框是几百像素宽的容器边界，同墨量下视觉重量差一个量级，
 *     卡框比窗格线淡是常态而非缺陷。换成绝对墨量的上下限。
 *
 * 三、卡片不许自己造背景，也不许自己开宽度档。
 *
 * 这个文件曾经住在根 tests/unit/ 并用 join(repoRoot, 'packages', 'ui', …)
 * 从包外面伸手读 CSS，目录一动就 ENOENT，连断三次。现在它读的是自己包里的
 * 相对路径：被测物搬到哪，它跟到哪。
 */

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..')
const tokensDir = join(srcDir, 'tokens')

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/*
 * 一条真正的 background 声明:属性名顶在 '{' 或 ';' 之后。
 *
 * 此前这里是 not.toContain('background'),既过松也过紧 —— 注释里出现这个词就红,
 * 而 --ui-card-background 这类 token 名同样被算成"卡片自己造了背景"。
 */
const BACKGROUND_DECL = /(?:^|[{;])\s*background(?:-[a-z]+)?\s*:/m

const declaredTokens = (css: string) =>
  new Set([...css.matchAll(/^\s*(--ui-[a-z0-9-]+):/gm)].map((m) => m[1]))

/* 取第一个捕获组，取不到就当场失败并说清是什么取不到。 */
const captureOf = (source: string, pattern: RegExp, what: string) => {
  const captured = pattern.exec(source)?.[1]

  if (captured === undefined) {
    throw new Error(`${what} 应当可解析`)
  }

  return captured
}

const declOf = (css: string, name: string) =>
  captureOf(css, new RegExp(`^\\s*${name}:\\s*([^;]+);$`, 'm'), name).trim()

/* 只接受 #rrggbb：能被取色器一比一核对的那种值。 */
const grayOf = (value: string) =>
  Number.parseInt(captureOf(value, /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i, value), 16)

/*
 * 读进来就把注释剥掉。
 *
 * 断言的对象是声明,不是文件文本。此前 stripComments 只在 declaredTokens /
 * declOf 里用,另外几条断言直接读原文:同一个文件两套读法。
 */
const declarationsIn = (...segments: string[]) =>
  stripComments(readFileSync(join(...segments), 'utf8'))

const light = declarationsIn(tokensDir, 'light.css')
const dark = declarationsIn(tokensDir, 'dark.css')
const surface = declarationsIn(srcDir, 'surface.css')

/* 基底取值来自 tokens/palette.css：neutral-50 ≈ #f8f8f8，dark-975 = #141414。 */
const GROUND = { light: 0xf8, dark: 0x14 }
const THEMES = [
  ['light', light],
  ['dark', dark],
] as const

const REQUIRED = [
  '--ui-background',
  '--ui-foreground',
  '--ui-surface',
  '--ui-card',
  '--ui-card-divider',
  '--ui-chrome',
  '--ui-ground',
  '--ui-sidebar',
  '--ui-sidebar-accent',
  '--ui-sidebar-accent-foreground',
  '--ui-region-divider-color',
  '--ui-divider',
  '--ui-divider-subtle',
  '--ui-border',
  '--ui-surface-frame',
  '--ui-surface-shadow',
  '--ui-input',
  '--ui-ring',
]

const inkOf = (name: 'light' | 'dark', css: string, token: string) =>
  Math.abs(grayOf(declOf(css, token)) - GROUND[name])

describe('theme token contract', () => {
  it('两个主题都覆盖必需的 token', () => {
    for (const [name, css] of THEMES) {
      const declared = declaredTokens(css)
      const missing = REQUIRED.filter((token) => !declared.has(token))
      expect(missing, `${name}.css 缺少 token`).toEqual([])
    }
  })

  it('两个主题声明的 token 集合完全一致', () => {
    const inLight = declaredTokens(light)
    const inDark = declaredTokens(dark)
    expect([...inLight].filter((t) => !inDark.has(t)).sort()).toEqual([])
    expect([...inDark].filter((t) => !inLight.has(t)).sort()).toEqual([])
  })
})

describe('two-tier border scale', () => {
  it('外框相对基底的对比度是卡内线的 3～6 倍', () => {
    for (const [name, css] of THEMES) {
      const frame = inkOf(name, css, '--ui-surface-frame')
      const rule = inkOf(name, css, '--ui-divider-subtle')
      expect(rule, `${name}: 卡内线不能与基底同色`).toBeGreaterThan(0)
      const ratio = frame / rule
      expect(ratio, `${name}: 外框/卡内线 对比度比例`).toBeGreaterThanOrEqual(3)
      expect(ratio, `${name}: 外框/卡内线 对比度比例`).toBeLessThanOrEqual(6)
    }
  })

  it('外框墨量不过重，卡内线不彻底消失', () => {
    for (const [name, css] of THEMES) {
      expect(inkOf(name, css, '--ui-surface-frame'), `${name}: 外框墨量`).toBeLessThanOrEqual(42)
      expect(inkOf(name, css, '--ui-divider-subtle'), `${name}: 卡内线墨量`).toBeGreaterThanOrEqual(
        3,
      )
    }
  })

  it('卡片不造背景，存在感由投影给', () => {
    /* 只认声明:--ui-card-background 一类的名字不算卡片自己造了背景。 */
    expect(BACKGROUND_DECL.test(surface), 'surface.css 不该声明 background').toBe(false)
    expect(declaredTokens(light).has('--ui-surface-fill'), 'light 不该有卡片填充').toBe(false)
    expect(declaredTokens(dark).has('--ui-surface-fill'), 'dark 不该有卡片填充').toBe(false)
    expect(declOf(surface, 'box-shadow')).toBe('var(--ui-surface-shadow)')
  })

  it('宽度只有全局那一档 1px', () => {
    /* 整值相等,不是"包含这段文字":加个 !important 也该判红,且不受折行影响。 */
    expect(declOf(surface, 'border')).toBe(
      'var(--ui-region-divider-width) solid var(--surface-line)',
    )
    expect(surface).not.toContain('--ui-surface-frame-width')
  })

  it('外框与卡内线各读对档位', () => {
    expect(declOf(surface, '--surface-line')).toBe('var(--ui-surface-frame)')
    expect(declOf(surface, '--surface-rule')).toBe('var(--ui-divider-subtle)')
  })

  it('--ui-border 归控件，跟随区域线', () => {
    for (const [, css] of THEMES) {
      expect(declOf(css, '--ui-border')).toBe('var(--ui-region-divider-color)')
    }
  })
})
