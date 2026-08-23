/*
 * 已经写完的那些块，和还在写的那一块。
 *
 * 流式 markdown 的代价不在「解析一次要多久」，在「同一段文本要被解析多少次」。
 * 一段思考链上屏时，整篇文本每一次刷新都被重新交给解析器一次 —— 第 n 帧解析 n 个
 * token，一轮下来是 O(n²)，而 n 是这条思考链的长度。屏幕上看到的就是：字先流得很
 * 顺，越往后越黏，最后停几秒。
 *
 * 行业标杆没有一个是这么做的。VS Code 的 chat 只重画尾部那一个未闭合块，Zed 的
 * acp_thread 把 markdown 按块缓存、只重解析最后一块。共同的前提是同一件事：markdown
 * 的块之间相互独立，一个已经闭合的块不会因为后面又来了几个字而改变含义。既然不会变，
 * 就不该再解析。
 *
 * 这个文件只做那一件事：找到所有可以安全封口的位置。
 *
 * 「最后一个」曾经就够用 —— 那时消费者只有一处，而它只想把全文分成「前面的」与
 * 「正在写的」两段。代价是前面那一段仍然是一个整体：每封口一块它就换一次字符串，
 * 于是前面所有块被重新解析一遍，n 块合计 n(n+1)/2 次。O(n²) 换了个位置，没有消失。
 * 切点本来就全在这一次扫描里，交出全部只是不再把它们丢掉。
 *
 * 「安全」是这里唯一的难点。切点必须落在两个块之间，而不是落在一个跨行结构的中间 ——
 * 切开一个列表会让编号重来、让 <ul> 断成两截，切开一个围栏会让代码变成正文。判据因此
 * 是保守的：拿不准就不切。一个切点都找不到时整篇就是一块，逐字退化成未拆分时的行为。
 */

/**
 * 这一行是不是某个跨行结构的一部分。
 *
 * 列表项、引用、表格行，以及 setext 标题的下划线 —— 它们的相邻行属于同一个块，中间
 * 那个空行是块内的空行（松散列表），不是块边界。
 */
const CONTINUES = /^\s{0,3}(?:[-*+>|=]|\d{1,9}[.)])/

/** 围栏的开合。缩进四格以上是缩进代码块，不是围栏。 */
const FENCE = /^\s{0,3}(?:```|~~~)/

/** 独占一行的 $：块级公式的开合。 */
const MATH_FENCE = /^\s{0,3}\$\$\s*$/

/** 当前落在哪一种跨行围栏里面。 */
export type Fence = 'none' | 'code' | 'math'

/**
 * 读完这一行之后，围栏状态变成什么。
 *
 * 围栏里只认自己那一种收口符：一个 ``` 块内部出现的 $ 是代码文本，不是公式
 * 的开头。这是 CommonMark 的规则，也是此前那两个布尔变量真正在表达的东西 ——
 * 它们表达得对，只是把它和「哪里可以切」缠在了同一个循环里。
 */
export function fenceAfter(line: string, open: Fence): Fence {
  if (open === 'code') {
    return FENCE.test(line) ? 'none' : 'code'
  }

  if (open === 'math') {
    return MATH_FENCE.test(line) ? 'none' : 'math'
  }

  if (FENCE.test(line)) {
    return 'code'
  }

  return MATH_FENCE.test(line) ? 'math' : 'none'
}

/**
 * 一个空行是不是块边界。
 *
 * previous 为空表示前面还没有内容；next 为空表示这是连续空行中的一个，边界在
 * 更后面那一个。两侧任意一侧属于跨行结构（列表、引用、表格、setext 下划线），
 * 这个空行就在块内，切开它会让编号重来、让 <ul> 断成两截。
 */
function separates(previous: string, next: string): boolean {
  if (previous === '' || next.trim() === '') {
    return false
  }

  return !CONTINUES.test(previous) && !CONTINUES.test(next)
}

/**
 * 一块 markdown，以及它的身份。
 *
 * key 是起始行号：块只追加，封口之后内容不再变，所以这个数恒定且唯一。它同时是
 * 虚拟化那一层认人的依据 —— 正在写的那一块封口时起始行号不变，于是它已经测到的
 * 高度不会因为「它现在算封口的了」而作废。
 *
 * lines 是逻辑行数，扫描的时候顺手就有。它只服务估高，而估高要的是下界：一行换行
 * 之后只会更高，不会更矮。
 */
export interface StreamBlock {
  readonly key: number
  readonly lines: number
  readonly text: string
}

/**
 * 行数，不分配。
 *
 * 估高要的是一个数，而 split('\n') 交出来的是一份完整的行表：为一篇长文本分配
 * 成千个字符串，其中没有一个被读过。
 */
export function countLines(text: string): number {
  let lines = 1

  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
    lines += 1
  }

  return lines
}

/**
 * 一次可以接着往下走的扫描。
 *
 * 切点是前缀确定的（理由见文件头），所以一次流式追加本来只需要扫新到的那几行。
 * 此前每一帧都把整篇重扫一遍：一次 split('\n') 分配整份行表，再对每一行跑两条
 * 正则 —— 第 n 帧扫 n 行，一轮下来 O(n²)，n 是这条回答的长度。
 *
 * 停点落在「它后面那一行也已经完整」的位置：一个空行是不是边界要看它的下一行
 *（separates），而正在写的那一行随时会变。因此停点之前的判据永不重算。
 */
interface Scan {
  /** 上一次交进来的那篇文本，也就是续扫的前缀判据。 */
  readonly source: string
  /** 上一次交出去的那一份，供同一篇文本被问第二次时原样交回。 */
  readonly result: readonly StreamBlock[]
  /** 已经封口的块。 */
  readonly blocks: StreamBlock[]
  /** 停点：下一行从这个字符开始，而它是第 line 行。 */
  readonly at: number
  readonly line: number
  /** 还没封口那一段从哪个字符、第几行开始。 */
  readonly from: number
  readonly start: number
  /** 停点之前最后一个非空行。 */
  readonly previous: string
  /** 停点处落在哪一种围栏里。 */
  readonly open: Fence
}

/**
 * 一条流的切分器。状态跟着流走，不藏在模块里。
 *
 * 这份状态此前是一个模块级单槽（let held），前提写在它自己的注释里：「同一时刻
 * 只有一段文本在长」。那个前提是假的 —— 调用者曾有两个：Prose 画回答，思考链面板
 * 画推理。一轮里两条流同时在屏幕上长，而它们的文本互不为前缀，于是每一帧两边
 * 轮流把对方的停点顶掉：前缀判据帧帧不命中，续扫退化成整篇重扫。这份状态要消除
 * 的那个 O(n²)，被它自己的单槽请了回来。并行子代理（一轮里几条流同时长）只会
 * 让它更糟，而这件事不改变任何一个字的输出，所以它只能靠读代码或者靠测试发现。
 *
 * 一条流一份进度，与转录那一层「一份投影按对话弱引用」同一个立场：谁的状态，谁
 * 持有。这个模块因此不再有任何跨流共享的可变量。
 */
export type BlockScanner = (text: string) => readonly StreamBlock[]

function scanner(): BlockScanner {
  let held: Scan | null = null

  return (text) => {
    held = scanFrom(held, text)

    return held.result
  }
}

/**
 * 这一趟从哪里接着扫。
 *
 * 只追加就接着上一趟走，判据是一次原生前缀比较，不分配；认不出前缀就从零起步，
 * 逐字退化成没有这份状态时的行为。
 *
 * 它单独成一个函数，是因为「能不能续」和「怎么扫」是两件事：写在一起时那几个
 * 兜底只在补「可能没有上一趟」这一个情形，而循环本身一个字都不关心它。
 */
function startFrom(held: Scan | null, text: string): Scan {
  if (held !== null && text.length > held.source.length && text.startsWith(held.source)) {
    return held
  }

  return {
    source: '',
    result: [],
    blocks: [],
    at: 0,
    line: 0,
    from: 0,
    start: 0,
    previous: '',
    open: 'none',
  }
}

/**
 * 这一行是内容，不是块之间那个空行。
 *
 * 只有「围栏外的空行」才有资格当边界：围栏里的行、围栏本身那两行、以及任何有字
 * 的行，都只是内容。before 是读这一行之前的围栏状态，after 是读完之后的 —— 开合
 * 那两行自己也算在围栏里，所以两头都要看。
 *
 * 空行不更新 previous，那不是疏忽：previous 的定义就是上一个非空行。
 */
function contentRow(row: string, before: Fence, after: Fence): boolean {
  return before !== 'none' || after !== 'none' || row.trim() !== ''
}

/**
 * 扫一趟，交出这一趟的停点与结果。
 *
 * 最后一块就是正在写的那一块：它后面没有安全切点，所以它是唯一还可能变的一块。前面
 * 每一块都已封口 —— 内容不再变，也就不该被解析第二次，也不该被切第二次。
 *
 * 至少交回一块（可能是空串）：一篇还没有任何内容的思考也有一个正在写的位置。
 *
 * 相邻两块之间少掉的正是切点那一个空行，而空行是块之间的分隔符本身：它属于分隔，
 * 不属于任何一块。
 */
function scanFrom(held: Scan | null, text: string): Scan {
  /* 同一篇文本被问第二次（一次渲染里 getSnapshot 会被调用不止一次）：原样交回。 */
  if (held !== null && held.source === text) {
    return held
  }

  const resumed = startFrom(held, text)
  const blocks = resumed.blocks

  let at = resumed.at
  let line = resumed.line
  let from = resumed.from
  let start = resumed.start
  let previous = resumed.previous
  let open: Fence = resumed.open

  for (;;) {
    const end = text.indexOf('\n', at)

    /* 最后那一行还在写：它不是一个可判定的边界，留给下一趟。 */
    if (end < 0) {
      break
    }

    /* 下一行也得完整：空行是不是边界要看它。停点因此永远可续。 */
    const after = text.indexOf('\n', end + 1)

    if (after < 0) {
      break
    }

    const row = text.slice(at, end)
    const before = open

    open = fenceAfter(row, open)

    if (contentRow(row, before, open)) {
      previous = row
    } else if (separates(previous, text.slice(end + 1, after))) {
      /* 切点那一行不属于任何一块：块止于它前面那个换行。 */
      blocks.push({ key: start, lines: line - start, text: text.slice(from, at - 1) })
      start = line + 1
      from = end + 1
    }

    at = end + 1
    line += 1
  }

  /*
   * 收尾时仍在围栏里，不影响任何一个已经记下的切点：切点只在围栏之外记录，所以它们
   * 全都落在这个未闭合围栏开始之前。而这正是最需要封口的场景 —— 一个正在被一行行写
   * 出来的代码块，前面那些已经写完的段落没有理由陪着它一起重新解析。
   */
  const tailText = text.slice(from)
  const last: StreamBlock = { key: start, lines: countLines(tailText), text: tailText }
  const result = blocks.length === 0 ? [last] : [...blocks, last]

  return { source: text, result, blocks, at, line, from, start, previous, open }
}

/*
 * 块表按文本寻址。
 *
 * 虚拟窗口卸载离开预取带的行，实例内的扫描进度随之消失，滚回去等于重扫一遍。这份缓存只认
 * 文本本身，所以跨卸载存活；上限让内存有界，先删再插使 Map 的插入序就是 LRU 序。
 */
const PROJECTION_CAP = 200

const projected = new Map<string, ReturnType<ReturnType<typeof scanner>>>()

export function createBlockScanner(): ReturnType<typeof scanner> {
  const scan = scanner()

  return (text: string) => {
    const cached = projected.get(text)

    if (cached !== undefined) {
      projected.delete(text)
      projected.set(text, cached)

      return cached
    }

    const blocks = scan(text)

    projected.set(text, blocks)

    if (projected.size > PROJECTION_CAP) {
      const oldest = projected.keys().next().value

      if (oldest !== undefined) {
        projected.delete(oldest)
      }
    }

    return blocks
  }
}
