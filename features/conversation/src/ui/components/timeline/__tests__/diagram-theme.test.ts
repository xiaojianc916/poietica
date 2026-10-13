import { describe, expect, test } from 'bun:test'

import { DIAGRAM_CSS, DIAGRAM_INKS } from '../diagram-theme'

/*
 * 这一段压的是 mermaid 自己生成的那份样式表，两边同样带 #id 前缀：胜负全在选择器多出来的
 * 那一个类上（.mindmap-node / .edge / .commit / .arrow / .branchLabelBkg）。少一个，配色
 * 就静默回到纯黑 —— 屏幕上看不出「少了一个类」与「颜色本来就这样」的区别，所以这里盯的
 * 是覆盖面与选择器，不是外观。
 */
describe('图的分支配色', () => {
  test('mindmap 十一条分支与根都盖到，且各自多带一个类', () => {
    for (let section = 0; section < 11; section += 1) {
      expect(DIAGRAM_CSS).toContain(`.mindmap-node.section-${section} rect`)
      expect(DIAGRAM_CSS).toContain(`.edge.section-edge-${section}`)
    }

    expect(DIAGRAM_CSS).toContain('.mindmap-node.section-root rect')
  })

  test('gitGraph 十二档的圆点、箭头、分支名底都盖到', () => {
    for (let branch = 0; branch < 12; branch += 1) {
      expect(DIAGRAM_CSS).toContain(`.commit.commit${branch} `)
      expect(DIAGRAM_CSS).toContain(`.commit.commit-highlight${branch} `)
      expect(DIAGRAM_CSS).toContain(`.arrow.arrow${branch} `)
      expect(DIAGRAM_CSS).toContain(`.branchLabelBkg.label${branch} `)
    }
  })

  test('颜色只从令牌来', () => {
    expect(DIAGRAM_CSS).not.toMatch(/#[0-9a-f]{3}|rgba?\(|hsla?\(/i)
    expect(DIAGRAM_CSS).toContain('var(--ui-secondary)')
    expect(DIAGRAM_CSS).toContain('var(--ui-foreground)')
  })

  /*
   * 这几处 mermaid 只肯从 themeVariables 收色：槽位丢了不会报错，只会静默回到它自己算的
   * 那套（ER 的隔行底会变回一条近白、饼图那几片回到纯黑）。
   */
  test('只走 themeVariables 的部位，槽位齐全', () => {
    expect(DIAGRAM_INKS).toHaveProperty('rowOdd')
    expect(DIAGRAM_INKS).toHaveProperty('rowEven')
    expect(DIAGRAM_INKS).toHaveProperty('pieStrokeColor')
    expect(DIAGRAM_INKS).toHaveProperty('pieOuterStrokeColor')

    for (let slice = 1; slice <= 12; slice += 1) {
      expect(DIAGRAM_INKS).toHaveProperty(`pie${slice}`)
    }
  })
})
