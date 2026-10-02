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
   * 三个队列模式**不占屏幕**：它们收在末尾那枚「队列设置」的弹层里。
   *
   * 它们是整条队列的设置，而正本每一行右侧那几枚按钮是「对**这一行正文**的操作」——
   * 摆进行的按钮列里，人读到的是「这一句能一次全喂」，那是错的。这一条钉的就是这件事：
   * 屏幕上只有一枚触发器，三个模式一个都不许以按钮的样子出现。
   */
  test('三个队列模式收在设置弹层里，不占屏幕', () => {
    const markup = render(['1111快点啊'], [])

    expect(markup).toContain('aria-label="队列设置"')
    expect(markup).not.toContain('prompt-queue__mode')
    expect(markup).not.toContain('aria-pressed')
    /* 它是那一行里的按钮，不是自己另起一条。 */
    const rows = markup.match(/<li class="prompt-queue__row">[\s\S]*?<\/li>/g) ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('aria-label="队列设置"')
  })

  /*
   * 按钮是**图标钮**：名字只在 aria-label 与提示条里，不落在按钮的字面上。正本每一枚
   * 操作钮都是这么给的（一枚字形配一条 Tooltip 与一条 aria-label）。
   */
  test('按钮只有字形，名字在 aria-label 里', () => {
    const markup = render(['1111快点啊'], [])
    const buttons =
      markup.match(/<button[^>]*class="prompt-queue__action[ "][^>]*>([\s\S]*?)<\/button>/g) ?? []

    /* 一行一枚撤回键 + 末尾一枚队列设置。 */
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(/aria-label="[^"]+"/.test(button)).toBe(true)
      /* 按钮里除了那枚字形不该再有字。 */
      expect(
        button
          .replace(/<svg[\s\S]*?<\/svg>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim(),
      ).toBe('')
    }
    /* 两枚名字不同：一枚管这一句，一枚管整条队列。 */
    expect(new Set(buttons.map((button) => /aria-label="([^"]+)"/.exec(button)?.[1])).size).toBe(2)
  })

  /*
   * 按钮**长在行自己的 flex 里**，不是另起一列。
   *
   * 判据落在 DOM 结构上：撤回键是那一行 <li> 的孩子，而不是一个与 <ul> 平级的兄弟。分家会
   * 让按钮游离在行之外 —— 屏幕上看就是一列悬在右边的钮，跟它要操作的那句话对不上。
   */
  test('按钮贴在它那一行的右缘，不是另起一列', () => {
    const markup = render(['先说这句'], ['说完再做这句'])
    const rows = markup.match(/<li class="prompt-queue__row">[\s\S]*?<\/li>/g) ?? []

    expect(rows).toHaveLength(2)
    /* 只有最后一行有按钮，且它在那一行自己的盒子里。 */
    expect(rows[0]).not.toContain('prompt-queue__action')
    expect(rows[1]).toContain('prompt-queue__action')
    /* 列表里没有第二列：按钮总数 = 行内那一枚 + 末尾那一枚。
       DropdownMenuTrigger 会往 class 后面追加它自己的类，所以按前缀匹配。 */
    expect(markup.match(/class="prompt-queue__action[ "]/g) ?? []).toHaveLength(2)
  })
})
