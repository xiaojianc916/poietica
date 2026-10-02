import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { EMPTY_QUEUE, MessageQueue, type MessageQueueState } from '../interjection/message-queue'
import { PromptQueue, queueRows } from '../surface/prompt-queue'

/*
 * 画法照抄 DeepSeek Harness 的 QueueDock（正本与逐条对应见 prompt-queue.css 的头注），
 * 所以这里钉的是「抄得对不对」加上本仓与它不同的那几处口径：
 *
 *   1. 行首只有一行时是队列记号，两行以上换成序号；
 *   2. 行与行之间不画分隔线；
 *   3. 屏幕上不出现「插话 / 排队 / 打断」这些词 —— 它们走提示条。
 *
 * 两半分开测：行的投影是纯函数（序号、署名、谁能撤），静态标记那一半验整块的骨架。
 * 折叠与提示条的内容不进 markup（本仓没有 DOM 测试环境），这里钉的是能看见的那部分。
 */

const state = (steering: readonly string[], followUp: readonly string[]): MessageQueueState => ({
  ...EMPTY_QUEUE,
  steering: [...steering],
  followUp: [...followUp],
})

const queue = (steering: readonly string[], followUp: readonly string[]): MessageQueue => {
  const instance = new MessageQueue({
    withdraw: async () => null,
    setModes: async () => ({
      sessionId: 'thread',
      steering: [],
      followUp: [],
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      interruptMode: 'immediate',
    }),
    failed: () => undefined,
  })
  instance.accept({ ...state(steering, followUp), sessionId: 'thread' })
  return instance
}

const render = (steering: readonly string[], followUp: readonly string[]): string =>
  renderToStaticMarkup(<PromptQueue onEdit={() => undefined} queue={queue(steering, followUp)} />)

describe('待发队列的行', () => {
  test('两层的顺序照 agent 报来的那一份，署名随行', () => {
    expect(queueRows(state(['先说这句'], ['说完再做这句']))).toEqual([
      { text: '先说这句', tier: '插话', ordinal: 1, last: false },
      { text: '说完再做这句', tier: '排队', ordinal: 2, last: true },
    ])
  })

  /*
   * 序号是屏幕上那个「第几条」：队列有序（撤回只从最后一条起），连排几句时哪句先走要
   * 一眼看得出。两层接着数，不在各自的队里从 1 重来 —— 走的是一个队。
   */
  test('序号跨两层连续，从 1 起', () => {
    expect(queueRows(state(['a', 'b'], ['c'])).map((row) => row.ordinal)).toEqual([1, 2, 3])
  })

  /*
   * 本机的撤回是 LIFO 一条命令（上游 `popLastQueuedMessage`，没有按号取），所以只有最后
   * 一行画得出撤回键 —— 不给按不动的行画一枚假键。这条判据就是 `last`。
   */
  test('最后一行才是可撤的那一行', () => {
    expect(queueRows(state(['a', 'b'], ['c'])).map((row) => row.last)).toEqual([false, false, true])
  })
})

describe('待发队列那一块', () => {
  test('空队列整条不画', () => {
    expect(render([], [])).toBe('')
  })

  /*
   * 正本的判据是 `rowCount === 1 || expanded`：只有一行时直接摊开，没有折叠头 —— 为一行
   * 再点一次头是白收一次。
   */
  test('一行直接摊开，不带折叠头，行首是队列记号', () => {
    const markup = render(['1111快点啊'], [])

    expect(markup).toContain('prompt-queue__row')
    expect(markup).toContain('1111快点啊')
    expect(markup).not.toContain('prompt-queue__header')
    expect(markup).not.toContain('条排队消息')
    /* 一句没有顺序可交代，行首是记号不是号。 */
    expect(markup).toContain('prompt-queue__lead')
    expect(markup).not.toContain('prompt-queue__ordinal')
  })

  /*
   * 两行以上才长出折叠头；但**缺省是摊开的** —— 队列是在等发的话，序号就是「谁先走」，
   * 折起来这两样都看不见。正本缺省折起，本仓按产品口径翻过来（见组件里那条注释）。
   */
  test('两行以上长出折叠头，且缺省就是摊开的', () => {
    const markup = render(['1111快点啊'], ['再补一句'])

    expect(markup).toContain('prompt-queue__header')
    expect(markup).toContain('2 条排队消息')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('prompt-queue__row')
  })

  /*
   * 两行以上，行首换成序号 —— 这时才真的有「谁先走」要说。序号是屏幕上的字（不是提示），
   * 所以它必须出现在 markup 里；两个队的名字则不出现（它们走提示条）。
   */
  test('两行以上行首是序号，且屏幕上不出现两队的名字', () => {
    /* 只看那几行：折叠头里也有一枚队列记号（它另有各测）。 */
    const list = render(['先说这句'], ['说完再做这句']).split('prompt-queue__list')[1] ?? ''

    expect(list).toContain('prompt-queue__ordinal')
    expect(list).not.toContain('prompt-queue__lead')
    expect(list).toContain('>1<')
    expect(list).toContain('>2<')
    /* 「插话」「排队」只进提示条，不进行里的字面。 */
    expect(list).not.toMatch(/>\s*(插话|排队)\s*</)
    expect(render(['先说这句'], ['说完再做这句'])).not.toContain('prompt-queue__tier')
  })

  /*
   * 行与行之间不画分隔线：几条待发的话是一串同类的行，横线会把它们读成一张表的几行。
   * 分开它们的是行高与那枚序号。
   */
  test('行与行之间没有分隔线', () => {
    const css = readFileSync(new URL('../surface/prompt-queue.css', import.meta.url), 'utf8')

    expect(css).not.toContain('.prompt-queue__row + .prompt-queue__row')
  })

  /*
   * 队列模式那一行是本仓多出来的（正本没有队列模式这个概念），但它长在同一张卡里，就
   * 得与那几行同档。三档的当前值都写进 aria-pressed，屏幕才读得出此刻喂的是哪一档。
   */
  test('队列模式那一行与待发的行同在一张卡里', () => {
    const markup = render(['1111快点啊'], [])

    expect(markup).toContain('prompt-queue__modes')
    /* 两档 × 三组，各一个按下态。 */
    expect(markup.match(/aria-pressed=/g) ?? []).toHaveLength(6)
    expect(markup.match(/aria-pressed="true"/g) ?? []).toHaveLength(3)
  })

  /*
   * 三组的记号两两不同，且都不与自己那两档的字形重样。
   *
   * 前两组的两档字形是同一对（一条一条 / 一次全喂），记号是唯一说得出「这一组管哪个队」
   * 的东西 —— 记号与档位撞脸时，屏幕上就是同形的图标挨着排，读不出哪一枚是标记。
   * 第三组曾经正是这样：记号和「立刻打断」都用了闪电。
   */
  test('三组记号两两不同，也不与自己的档位字形重样', () => {
    const markup = render(['1111快点啊'], [])
    const marks = [...markup.matchAll(/prompt-queue__mode-mark[^>]*>(<svg[\s\S]*?<\/svg>)/g)].map(
      (match) => match[1],
    )

    /* 三组各一枚记号。 */
    expect(marks).toHaveLength(3)
    expect(new Set(marks).size).toBe(3)

    /* 每一组：记号那枚字形不在它自己那两档按钮里。 */
    for (const [index, mark] of marks.entries()) {
      const group = (markup.match(
        /<span class="prompt-queue__mode">[\s\S]*?(?=<span class="prompt-queue__mode">|$)/g,
      ) ?? [])[index]
      const buttons = group?.replace(/prompt-queue__mode-mark[^>]*>[\s\S]*?<\/svg>/, '') ?? ''
      expect(buttons).not.toContain(mark)
    }
  })

  /*
   * 屏幕上那一排全是图标按钮：名字只在 aria-label 与提示条里，不落在按钮的字面上。
   * 正本每一枚操作钮都是这么给的（一枚字形配一条 Tooltip 与一条 aria-label），带字的
   * 按钮读起来是一排标签，与它旁边那枚撤回键也不是同一种东西。
   */
  test('那一排按钮只有字形，名字在 aria-label 里', () => {
    /* 只看档位那一行：同一行里那枚撤回键也带这个类，它另有各测。 */
    const markup = render(['1111快点啊'], []).split('prompt-queue__modes')[1] ?? ''
    const buttons =
      markup.match(/<button[^>]*class="prompt-queue__action"[^>]*>([\s\S]*?)<\/button>/g) ?? []

    /* 六枚档位钮，全都只有一枚字形。 */
    expect(buttons).toHaveLength(6)
    for (const button of buttons) {
      const label = /aria-label="([^"]+)"/.exec(button)?.[1] ?? ''
      expect(label.length).toBeGreaterThan(0)
      /* 按钮里除了那枚字形不该再有字。 */
      expect(
        button
          .replace(/<svg[\s\S]*?<\/svg>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim(),
      ).toBe('')
    }
    /* 两组的字形两两不同，三组一共六枚名字。 */
    expect(new Set(buttons.map((button) => /aria-label="([^"]+)"/.exec(button)?.[1])).size).toBe(6)
  })
})
