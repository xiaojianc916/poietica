import { describe, expect, it } from 'bun:test'
import { createBlockScanner, type StreamBlock } from '../timeline/split-stream'

/*
 * 切分是这个界面的性能地基：一块 markdown 封口之后不该被解析第二次，而「哪里可以
 * 封口」全靠这一趟扫描。它此前一个测试都没有 —— 于是「续扫是不是真的在续」这件事
 * 谁都证不了，而它不改变任何一个字的输出：单槽被另一条流顶掉时，屏幕上完全正确，
 * 只是每一帧重扫整篇。这种缺陷只有测试抓得住，读注释是抓不住的（那句「同一时刻只
 * 有一段文本在长」在文件里躺了很久，而它是假的）。
 *
 * 判据因此不是「切出来的字对不对」，还包括「已经封口的那些块是不是同一个对象」：
 * 重造对象就等于重扫了一遍。
 */

const texts = (blocks: readonly StreamBlock[]) => blocks.map((block) => block.text)

describe('createBlockScanner', () => {
  it('一个字一个字喂进去，和一次喂完，切出来的块逐字相同', () => {
    const text = '# 标题\n\n段一\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n收尾。\n'
    const streaming = createBlockScanner()

    let streamed: readonly StreamBlock[] = []

    for (let at = 1; at <= text.length; at += 1) {
      streamed = streaming(text.slice(0, at))
    }

    expect(streamed).toEqual(createBlockScanner()(text))
  })

  it('续扫不重造已经封口的那些块', () => {
    const split = createBlockScanner()
    const first = split('段一\n\n段二\n\n')

    expect(split('段一\n\n段二\n\n段三')[0]).toBe(first[0])
  })

  /*
   * 一轮里两条流同时在长（回答与思考链，或者几个并行子代理），它们互不为前缀。
   * 进度共用一格时，这一句就会重造「段一」——每一帧都重造。
   */
  it('两条流各有自己的进度，谁都顶不掉谁', () => {
    const answer = createBlockScanner()
    const thought = createBlockScanner()
    const first = answer('段一\n\n段二\n\n')

    thought('别的\n\n流\n\n')

    expect(answer('段一\n\n段二\n\n段三')[0]).toBe(first[0])
  })

  it('空行是块之间的分隔符，不属于任何一块', () => {
    expect(texts(createBlockScanner()('段一\n\n段二\n\n段三\n'))).toEqual([
      '段一',
      '段二',
      '段三\n',
    ])
  })

  it('围栏里的空行不是边界：切开它，代码就变成正文', () => {
    const text = '前言\n\n```ts\nconst a = 1\n\nconst b = 2\n```'

    expect(texts(createBlockScanner()(text))).toEqual([
      '前言',
      '```ts\nconst a = 1\n\nconst b = 2\n```',
    ])
  })
})
