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
 *   3. 屏幕上不出现「插话 / 排队」这些词 —— 它们走提示条；
 *   4. 三档投递里缺省是 followUp（这一轮跑完再送出去），它**不画图标**；另两档（steer /
 *      aside）各一枚，且都只有最后一行画得出（换层 = 撤回再重投，撤回是 LIFO）。
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

/* 只挑那两枚换层图标：撤回键与它们同类，但不在这一组里。 */
const DELIVERY_LABELS = ['插话：插进正在跑的这一轮', '旁注：不打断，找个空档悄悄说']

const deliveryButtons = (markup: string): readonly string[] =>
  (markup.match(/<button[^>]*class="prompt-queue__action[ "][^>]*>/g) ?? []).filter((button) =>
    DELIVERY_LABELS.some((label) => button.includes(`aria-label="${label}"`)),
  )

const render = (steering: readonly string[], followUp: readonly string[]): string =>
  renderToStaticMarkup(
    <PromptQueue
      onEdit={() => undefined}
      onRedeliver={() => undefined}
      queue={queue(steering, followUp)}
    />,
  )

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
   * 两枚换层图标：一行时贴那一行的右缘，多行时贴折叠头的右缘。
   *
   * 它们换的是**最后那一条**（撤回再重投，omp 没有按条改层的 API），所以只有最后一行
   * 配得上这两枚键 —— 中间那几行画不了，不给按不动的行画假键。
   */
  test('两枚换层图标：一行时在行右缘，多行时在折叠头右缘', () => {
    const one = render(['1111快点啊'], [])
    const many = render(['先说这句'], ['说完再做这句'])

    /* 一行：没有折叠头，两枚图标在那一行里。 */
    expect(one).not.toContain('prompt-queue__header')
    const oneRow = one.match(/<li class="prompt-queue__row">[\s\S]*?<\/li>/)?.[0] ?? ''
    expect(deliveryButtons(oneRow)).toHaveLength(2)

    /* 多行：两枚图标在折叠头里，且不在任何一行里。 */
    expect(many).toContain('prompt-queue__header')
    const head = many.match(/<div class="prompt-queue__header">[\s\S]*?<\/div><ul/)?.[0] ?? ''
    expect(deliveryButtons(head)).toHaveLength(2)
    for (const row of many.match(/<li class="prompt-queue__row">[\s\S]*?<\/li>/g) ?? []) {
      expect(deliveryButtons(row)).toHaveLength(0)
    }
  })

  /*
   * 三档投递里**缺省那一档不画图标**。
   *
   * 缺省是 followUp（这一轮跑完再送出去）：屏幕上没有图标就是它 —— 给缺省态也画一枚键，
   * 人读到的是「要按一下才生效」。所以另两档各一枚，一共两枚，且都不是 followUp。
   */
  test('缺省档 followUp 不画图标，另两档各一枚', () => {
    const markup = render(['1111快点啊'], [])

    /* 两枚图标，名字是另两档。 */
    expect(deliveryButtons(markup)).toHaveLength(2)
    expect(markup).toContain('aria-label="插话：插进正在跑的这一轮"')
    expect(markup).toContain('aria-label="旁注：不打断，找个空档悄悄说"')
    /* 缺省那一档不出现。 */
    expect(markup).not.toContain('排队：这一轮跑完再送出去')
  })

  /*
   * 按钮是**图标钮**：名字只在 aria-label 与提示条里，不落在按钮的字面上。正本每一枚
   * 操作钮都是这么给的（一枚字形配一条 Tooltip 与一条 aria-label）。
   */
  test('按钮只有字形，名字在 aria-label 里', () => {
    const markup = render(['1111快点啊'], [])
    const buttons =
      markup.match(/<button[^>]*class="prompt-queue__action[ "][^>]*>([\s\S]*?)<\/button>/g) ?? []

    /* 一行：两枚换层 + 一枚撤回。 */
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(/aria-label="[^"]+"/.test(button)).toBe(true)
      expect(
        button
          .replace(/<svg[\s\S]*?<\/svg>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim(),
      ).toBe('')
    }
    /* 三枚名字互不相同。 */
    expect(new Set(buttons.map((button) => /aria-label="([^"]+)"/.exec(button)?.[1])).size).toBe(3)
  })

  /*
   * 三枚控件（换层两枚 + 撤回一枚）改的都是**最后那一条**，所以它们同在一处，不是散在
   * 各行上。
   *
   * 多行时它们在折叠头里（连同最右那枚折角）；一行时没有折叠头，三枚都贴那一行的右缘。
   * 把撤回单独留在最后一行上，读起来就是「只有这一行能删」的一枚孤零零的键 —— 那不是
   * 它的语义。
   */
  test('三枚控件跟着「最后一条」走：一行时在行内，多行时在折叠头里', () => {
    const one = render(['先说这句'], [])
    const many = render(['先说这句'], ['说完再做这句'])

    /* 一行：三枚都在那一行里，且行里没有折角钮（没有可折的东西）。 */
    const oneRow = one.match(/<li class="prompt-queue__row">[\s\S]*?<\/li>/)?.[0] ?? ''
    expect(oneRow).toContain('撤回最后一条')
    expect(oneRow).toContain('插话：插进正在跑的这一轮')
    expect(oneRow).toContain('旁注：不打断，找个空档悄悄说')

    /* 多行：三枚都在折叠头里，行里一枚都没有。 */
    const head = many.match(/<div class="prompt-queue__header">[\s\S]*?<\/div><ul/)?.[0] ?? ''
    expect(head).toContain('撤回最后一条')
    expect(head).toContain('插话：插进正在跑的这一轮')
    for (const row of many.match(/<li class="prompt-queue__row">[\s\S]*?<\/li>/g) ?? []) {
      expect(row).not.toContain('撤回最后一条')
      expect(deliveryButtons(row)).toHaveLength(0)
    }
  })

  /*
   * 折角钮排在那一排的最右：它只说「这一块能收起来」，夹在操作钮中间会被当成第四枚操作。
   */
  test('折角钮在控件组最右', () => {
    const head =
      render(['先说这句'], ['说完再做这句']).match(
        /<div class="prompt-queue__header">[\s\S]*?<\/div><ul/,
      )?.[0] ?? ''
    const labels = [...head.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1])

    /* 撤回 → 换层两枚 → 折角，折角最后。 */
    expect(labels[labels.length - 1]).toBe('收起排队消息')
  })
})
