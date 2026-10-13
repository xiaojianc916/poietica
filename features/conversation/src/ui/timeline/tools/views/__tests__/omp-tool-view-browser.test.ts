import { describe, expect, test } from 'bun:test'
import { ompToolView } from '../../omp-tool-view'

/*
 * 运行中就认出是浏览器（B-17）。
 *
 * `eval` 的 invokedTool 决定时间线把这一行交给谁画（timeline-row 按它找贡献的卡片），
 * 而状态事件要等 prelude 真正被调用才随产出推上来。只看产出的话，一次 browser.open
 * 的开头几百毫秒会先长成「运行 JavaScript」，第一条 status 到达后再突变成浏览器卡片 ——
 * 屏幕上是一次跳变。
 *
 * 所以 ops 为空时按**代码文本**预判一次。这里钉住预判的判据与它的边界。
 */

describe('运行中的 eval：按代码预判是不是浏览器', () => {
  test('代码里调 browser.open 时当场认成浏览器', () => {
    const view = ompToolView('eval', { language: 'js', code: 'await browser.open({ url: "https://a.com" })' }, null)

    expect(view.invokedTool).toBe('browser')
  })

  test('tab / tabs / close 也算：一次调用里写的可能是别的入口', () => {
    expect(ompToolView('eval', { code: 'const t = browser.tab("main")' }, null).invokedTool).toBe('browser')
    expect(ompToolView('eval', { code: 'await browser.tabs()' }, null).invokedTool).toBe('browser')
    expect(ompToolView('eval', { code: 'await browser.close({ all: true })' }, null).invokedTool).toBe('browser')
  })

  test('同时用 computer 时不预判：那是两件事，认错比晚认更糟', () => {
    const code = 'await browser.open({ url: "https://a.com" })\nawait computer.click(10, 10)'

    expect(ompToolView('eval', { language: 'js', code }, null).invokedTool).toBe('eval')
  })

  /*
   * 判据是「出现调用形状」而不是「解析代码」：只把 browser 当变量名用的代码不预判。
   *
   * 反过来，写在字符串里的 `browser.open(` 会被认成浏览器调用 —— 这是本次预判**接受**的
   * 代价（见阶段 0 文档的风险一节）：卡片仍会照常显示代码与输出，信息不丢，只是标题先
   * 说成浏览器动作。真要分清得跑一遍解析器，那比这条收益大得多。
   */
  test('只是把 browser 当普通变量用时不预判', () => {
    expect(ompToolView('eval', { code: 'const browser = 1; const open = 2' }, null).invokedTool).toBe('eval')
    expect(ompToolView('eval', { code: 'browser.open = 1' }, null).invokedTool).toBe('eval')
  })

  test('产出里已经有状态事件时照旧按 op 认（预判只补没产出的那段）', () => {
    const view = ompToolView(
      'eval',
      { language: 'js', code: 'const code = 1' },
      { content: [{ type: 'text', text: 'ok' }], details: { statusEvents: [{ op: 'browser', detail: 'tabs' }] } },
    )

    expect(view.invokedTool).toBe('browser')
  })

  test('两个 prelude 都调过时不认成浏览器（ops.length !== 1 的既有规矩）', () => {
    const view = ompToolView(
      'eval',
      { language: 'js', code: 'x' },
      {
        content: [],
        details: {
          statusEvents: [
            { op: 'browser', detail: 'tabs' },
            { op: 'computer', detail: 'click 10 10' },
          ],
        },
      },
    )

    expect(view.invokedTool).toBe('eval')
  })

  test('不是浏览器的代码一个字都不改', () => {
    expect(ompToolView('eval', { language: 'js', code: 'return 1 + 1' }, null).invokedTool).toBe('eval')
    expect(ompToolView('python', { language: 'py', code: 'import os' }, null).invokedTool).toBe('python')
  })
})
