import type { ThreadRecord } from '@poietica/agent-contract'

/*
 * 一条对话叫什么，只有这一份规则。
 *
 * 它此前是 ThreadsStore 的一个私有方法，可它一个实例字段都不读 —— 收 record，
 * 收占位，交出名字。锁在 35KB 的 store 里，唯一的效果是它测不了、也复用不了。
 */

/** Shown for a conversation nothing has named yet: the words of the entry. */
export const FALLBACK_TITLE = '新建对话'

/**
 * 名字最多占多少显示列。
 *
 * 此前按 UTF-16 码元数 24 截：汉字与拉丁字母在屏幕上不等宽，同一个 24 对中文
 * 是一整句、对英文只有半句，而且 slice 会把一枚 emoji 从代理对中间切开。现在
 * 按列数：宽字符记 2、窄字符记 1，48 列对纯中文恰好还是 24 个字，对英文翻倍。
 * 像素级的省略号仍归 CSS —— 这里守的是落库与标签页的数据上限。
 */
const TITLE_COLUMNS = 48

/* 切名字用字素簇（Intl.Segmenter，平台自带），不数码元：码元会切开 emoji。 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/*
 * UAX #11 East Asian Width 里稳定的宽块（CJK 表意与扩展、假名、谚文、全角形、
 * CJK 标点），emoji 用 Extended_Pictographic 判。与 string-width 一类库同一做法；
 * 上限差一列没有可见后果，所以不为它引依赖。
 */
// 匹配：汉字、韩文、日文假名 + 全角符号 + Emoji
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\u{20000}-\u{2FFFD}|\u{30000}-\u{3FFFD}|\p{Extended_Pictographic}/u

/** Cuts a stand in title down to something a tab can show. */
export const shorten = (text: string): string => {
  const tidy = text.trim().replace(/\s+/g, ' ')

  if (tidy.length === 0) {
    return FALLBACK_TITLE
  }

  const graphemes = [...segmenter.segment(tidy)].map((segment) => segment.segment)
  let used = 0
  let kept = 0

  for (const grapheme of graphemes) {
    used += WIDE.test(grapheme) ? 2 : 1

    if (used > TITLE_COLUMNS) {
      return `${graphemes.slice(0, kept).join('')}…`
    }

    kept += 1
  }

  return tidy
}

/** 结尾的分叉序号：半角 (n)。 */
const FORK_ORDINAL = /^(?<base>.*?)\((?<ordinal>\d+)\)$/u

/**
 * 分叉出的对话叫什么：源名加 (2)；源名自己带序号就换成下一个 —— (2) 的分叉
 * 是 (3)，不是 (2)(2)。序号排在截断之后，所以它永远在：'122345…(2)'，省略号
 * 只吃正文。落库按用户起的名（manual）对待，首句派生名顶不掉它。
 */
export const forkNameOf = (source: string): string => {
  const matched = FORK_ORDINAL.exec(source.trim())
  const base = matched?.groups?.['base'] ?? source
  const next = Number(matched?.groups?.['ordinal'] ?? '1') + 1

  return `${shorten(base)}(${String(next)})`
}

/**
 * 名字的排名：用户手打的 > 第一句话 > 入口占位。
 *
 * 占位存在的理由只有一个：平台还没记下这条对话，屏幕上总得写点什么。它一旦
 * 排到权威名字之上，就从"还没有名字时的替身"变成"永远压着名字的一层"。
 *
 * titleSource === 'message' 时那一格装的就是第一句话，逐字 —— 库那侧
 * record_prompt 的 CASE 只在 fallback 时写标题。
 */
export function nameOf(found: ThreadRecord | undefined, provisional: string | undefined): string {
  if (found?.titleSource === 'manual') {
    return found.title
  }

  if (found?.titleSource === 'message') {
    return shorten(found.title)
  }

  return provisional ?? FALLBACK_TITLE
}
