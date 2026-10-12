import { describe, expect, it } from 'bun:test'
import { MAX_SENTENCE_CHARS, readThoughtSentence, stripThoughtMarkup } from '../thought-sentence'

/*
 * 组头那一行取的是哪一句话。
 *
 * 两条都是老毛病的回归：用行号当身份时一整段不换行的思考从头到尾看不到换句（T-04）；
 * 逐字照抄不认 Markdown 时屏幕上会出现 `**`、`#`、围栏（T-06）。
 *
 * 判据的重心是**身份稳不稳**：同一句继续写，key 必须一模一样 —— 容器靠它决定是「原地长字」
 * 还是「上下刷一次」。key 一旦随字数变，每个 token 都会被当成换句。
 */

const han = (count: number): string => '啊'.repeat(count)

describe('取句：句界', () => {
  it('一个字都没有时交出空身份', () => {
    expect(readThoughtSentence('')).toEqual({ current: { key: '', text: '' }, previous: null })
    expect(readThoughtSentence('  \n ')).toEqual({ current: { key: '', text: '' }, previous: null })
  })

  it('中文句号断句，不要求后面有空格', () => {
    const said = readThoughtSentence('我先看看。然后')

    expect(said.current).toEqual({ key: '5', text: '然后' })
    expect(said.previous).toEqual({ key: '0', text: '我先看看。' })
  })

  it('句号后面还没有字：这一句还没结束，不算换句', () => {
    expect(readThoughtSentence('我先看看。').current).toEqual({ key: '0', text: '我先看看。' })
    expect(readThoughtSentence('我先看看。  ').current).toEqual({ key: '0', text: '我先看看。' })
  })

  it('收尾引号归前一句', () => {
    const said = readThoughtSentence('他说：“好。”然后')

    expect(said.current.text).toBe('然后')
    expect(said.previous?.text).toBe('他说：“好。”')
  })

  it('换行是句界', () => {
    expect(readThoughtSentence('第一行\n第二行').current).toEqual({ key: '4', text: '第二行' })
    /* CRLF 先归一成 \n，偏移因此按归一后的文本算：偏移是这一层内部的身份，不对外承诺。 */
    expect(readThoughtSentence('第一行\r\n第二行').current).toEqual({ key: '4', text: '第二行' })
  })

  it('同一句继续写，身份不变', () => {
    const first = readThoughtSentence('我先看看。然后')
    const more = readThoughtSentence('我先看看。然后再说')

    expect(more.current.key).toBe(first.current.key)
    expect(more.current.text).not.toBe(first.current.text)
  })

  it('连续追加任意长度的字，身份一直不变', () => {
    const key = readThoughtSentence('开始。写').current.key

    for (let count = 1; count <= 40; count += 1) {
      expect(readThoughtSentence(`开始。写${han(count)}`).current.key).toBe(key)
    }
  })
})

describe('取句：英文标点', () => {
  it('缩写里的点不是句界', () => {
    expect(readThoughtSentence('Use e.g. this. Next').current.text).toBe('Next')
    expect(readThoughtSentence('Use e.g. this. Next').current.key).toBe('15')
    expect(readThoughtSentence('the Dr. Smith file').current.text).toBe('the Dr. Smith file')
  })

  it('小数、文件名、版本号里的点不是句界', () => {
    expect(readThoughtSentence('pi is 3.14 ok').current.text).toBe('pi is 3.14 ok')
    expect(readThoughtSentence('看 file.ts 和 v1.2').current.text).toBe('看 file.ts 和 v1.2')
  })

  it('省略号不是句界：思考里常用来表示还没想完', () => {
    expect(readThoughtSentence('Wait... maybe').current.text).toBe('Wait... maybe')
    expect(readThoughtSentence('还在想……然后呢').current.text).toBe('还在想……然后呢')
  })

  it('英文的 ! ? . 后面必须跟空白才算断句', () => {
    expect(readThoughtSentence('Done! Next').current.text).toBe('Next')
    expect(readThoughtSentence('Done!Next').current.text).toBe('Done!Next')
    expect(readThoughtSentence('Really? Yes').current.text).toBe('Yes')
    expect(readThoughtSentence('Really?Yes').current.text).toBe('Really?Yes')
    /* 姓名缩写后面不带空白：缩写的判据在点号上，这条走的是另一档。 */
    expect(readThoughtSentence('J. Smith wrote').current.text).toBe('J. Smith wrote')
  })
})

describe('取句：超长段落', () => {
  it('没有标点的长段落按软句切开，第二句的身份落在 400 上', () => {
    const said = readThoughtSentence(han(450))

    expect(said.current.key).toBe(String(MAX_SENTENCE_CHARS))
    expect(said.current.text).toBe(han(50))
    expect(said.previous?.key).toBe('0')
  })

  it('切点由句首向前推，继续追加时身份不移动', () => {
    const key = readThoughtSentence(han(450)).current.key

    expect(readThoughtSentence(han(500)).current.key).toBe(key)
    expect(readThoughtSentence(han(900)).current.key).toBe(String(MAX_SENTENCE_CHARS * 2))
  })

  it('软句优先断在标点或空白之后', () => {
    const said = readThoughtSentence(`${han(330)}，${han(100)}`)

    /* 330 个字之后那个逗号是区间内最后的可断处，它归前一句。 */
    expect(said.current.key).toBe('331')
  })

  it('切点不落在代理对中间', () => {
    /* emoji 占住第 399、400 两个码元：硬切在 400 会把它劈成半个。 */
    const said = readThoughtSentence(`${han(399)}😀${han(200)}`)

    /* 右移一位让开它 —— 偏移+1，那一句因此从 401 起。 */
    expect(said.current.key).toBe('401')
    expect(said.current.text).toBe(han(200))
  })
})

describe('取句：Markdown 记号', () => {
  it('行首记号去掉', () => {
    expect(readThoughtSentence('## 标题').current.text).toBe('标题')
    expect(readThoughtSentence('- 项目').current.text).toBe('项目')
    expect(readThoughtSentence('1. 第一').current.text).toBe('第一')
    expect(readThoughtSentence('> 引用').current.text).toBe('引用')
  })

  it('强调与代码记号去掉，偏移仍按原文算', () => {
    const said = readThoughtSentence('**重点**是 `x` 和 [链接')

    expect(said.current.text).toBe('重点是 x 和 链接')
    expect(said.current.key).toBe('0')
  })

  it('单个星号下划线不处理：误伤的代价更大', () => {
    expect(stripThoughtMarkup('a_b 与 2*3')).toBe('a_b 与 2*3')
  })

  it('围栏行去记号后为空，当前句退回上一句人话', () => {
    const said = readThoughtSentence('第一句。\n```ts\n')

    expect(said.current.text).toBe('第一句。')
    expect(said.current.key).toBe('0')
  })

  it('整段就是围栏时交出空身份，交给占位那一格兜住', () => {
    expect(readThoughtSentence('```ts\nconst a = 1\n```').current).toEqual({ key: '', text: '' })
  })

  it('去记号只影响显示文本，不影响句界', () => {
    /* `e.g.` 那一条的判据在原文上：去掉记号之后仍是同一句。 */
    expect(readThoughtSentence('见 e.g. **这个**。然后').current.text).toBe('然后')
  })
})
