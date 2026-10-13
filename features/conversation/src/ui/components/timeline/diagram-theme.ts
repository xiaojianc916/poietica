/*
 * mermaid 的 `base` 主题是唯一一套把颜色交出来的主题：`themeVariables` 里的每个键都是
 * 画布上的一个部位。代价是它只认具体颜色（官方用 tinycolor 解析每个值，喂 `var(--x)` 会
 * 当场抛 Unsupported color format），而本仓的颜色只以设计令牌存在，令牌求值后还可能停在
 * oklch() / color() 这类现代写法上 —— 所以这里有两次归一：先经探针元素过一遍样式引擎把
 * 令牌求值，再用 1×1 的画布读回实际像素，交出去的永远是 rgb()/rgba()。
 *
 * 取色一律读语义令牌，不写字面值：深浅两套主题各自成立，换主题时重新解析一次即可。
 *
 * 三条路线，按 mermaid 肯不肯把那个部位交出来分：
 *
 *   themeVariables   交得出来的部位（节点面、连线、饼图的十二个扇区、ER 表的隔行底）。
 *                    令牌先解析成 rgb 再递进去。
 *   themeCSS         交不出来的部位 —— 这些颜色是**算**出来的，而 base 主题的算式在这里没
 *                    有出路：cScale 一族（mindmap 的分支）与 git0…git7（gitGraph 的圆点、
 *                    箭头、分支名底）拿到值之后会被再压暗 25 格，深色下令牌本来就落在
 *                    oklch(0.19…) 这一档，减 25 一律夹到 0 —— 整张图落到纯黑。themeCSS 是
 *                    官方留的出口，这份 CSS 会被拼进图自己的 <style>，于是能直接写令牌。
 *   `!important`    不写。要压过 mermaid 自己生成的那份（同样带 #id 前缀），选择器多带一个
 *                    类就够，见各处注释。
 */

import { invariant } from '@poietica/foundation'

/*
 * 一档兑墨：把前景墨按百分比兑进节点面。
 *
 * 深色下越兑越亮、浅色下越兑越暗 —— 两边都是「越兑越显眼」，同一个档位在两套主题里说的是
 * 同一件事。图里所有按序号分级的颜色（分支、扇区、表的隔行）都从这一条式子来。
 */
function ink(percent: number): string {
  return `color-mix(in oklab, var(--ui-foreground) ${percent}%, var(--ui-secondary))`
}

/* 一条分支比上一条重一档，三档一循环。 */
const BRANCH_STEP = 10
const BRANCH_CYCLE = 3

function branchInk(step: number): string {
  return ink(BRANCH_STEP * step)
}

/*
 * 面板上真正会被用到的部位。键是 mermaid 的 themeVariables 名，值是设计令牌或令牌式子。
 *
 * 节点面取 --ui-secondary：它是卡面那一级，深色下是压在地色上的一层灰（比 #181818 抬
 * 一档），浅色下是比白底沉一档的灰。读起来是「一张卡片」而不是「一块高亮」—— 图长在
 * 对话里，不该比正文更抢眼。节点框取 --ui-popover-trigger-frame，是这套设计里容器的边
 * 那一档；文字取 --cp-timeline-body-ink，与正文同一墨色。
 */
export const DIAGRAM_INKS = {
  background: 'transparent',
  clusterBkg: 'var(--ui-secondary)',
  clusterBorder: 'var(--ui-divider)',
  edgeLabelBackground: 'var(--ui-background)',
  lineColor: 'var(--cp-ink-muted)',
  mainBkg: 'var(--ui-secondary)',

  /*
   * 饼图的十二个扇区。mermaid 的 pie 只有 themeVariables 这一个口子 —— 切片是 fill 属性、
   * 图例那几格是内联 style，两处都从这一份数组按顺序取色，CSS 够不到图例。
   *
   * 档位不是等距的：十二档只能挤在 0～48 这个还读得清字的区间里，等距等于每档四五格，常见
   * 的三四片饼就糊成一片。这里按平方根排开（48·√(n/11)）：前几片拉得开，3 片落在 0 / 14 /
   * 20、4 片落在 0 / 14 / 20 / 25，十片以上本来就稠，挤在后面几档。
   */
  pie1: ink(0),
  pie2: ink(14),
  pie3: ink(20),
  pie4: ink(25),
  pie5: ink(29),
  pie6: ink(32),
  pie7: ink(35),
  pie8: ink(38),
  pie9: ink(41),
  pie10: ink(43),
  pie11: ink(46),
  pie12: ink(48),
  /* 扇区之间的缝留地色（一片一片地摊在底上），最外那一圈取区域线那一档墨。 */
  pieOuterStrokeColor: 'var(--ui-divider)',
  pieStrokeColor: 'var(--ui-background)',

  primaryBorderColor: 'var(--ui-popover-trigger-frame)',
  primaryColor: 'var(--ui-secondary)',
  primaryTextColor: 'var(--cp-timeline-body-ink)',

  /*
   * ER 表的隔行底。它默认走的是 base 主题那条「主色提亮 75 格」的算式 —— 深浅两套主题都
   * 会算出一条近白（深色下就是截图里那条白带）。奇数行取节点面本身，偶数行兑一档墨。
   */
  rowEven: branchInk(1),
  rowOdd: branchInk(0),

  secondaryColor: 'var(--ui-secondary)',
  tertiaryColor: 'var(--ui-secondary)',
  textColor: 'var(--cp-timeline-body-ink)',
} as const

export type DiagramInks = Record<keyof typeof DIAGRAM_INKS, string>

/* 一像素就够：全部要的只是「浏览器把这个颜色算成了哪几个通道」，不求画面。 */
function rasterizer(): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas')

  canvas.width = 1
  canvas.height = 1

  return canvas.getContext('2d', { willReadFrequently: true })
}

/*
 * 令牌 → rgb()/rgba()。
 *
 * 探针挂在正文里，与图同一个祖先，因此读到的就是这张图此刻该用的那一套（data-theme 在
 * 文档根上，深浅切换会换掉所有令牌的值）。
 */
export function diagramInks(host: HTMLElement): DiagramInks {
  const probe = document.createElement('span')
  const context = rasterizer()

  invariant(context !== null, 'diagram inks need a 2d canvas')

  probe.style.display = 'none'
  host.append(probe)

  const computed = getComputedStyle(probe)
  const inks: Record<string, string> = {}

  try {
    for (const [slot, color] of Object.entries(DIAGRAM_INKS)) {
      if (color === 'transparent') {
        inks[slot] = 'transparent'
        continue
      }

      probe.style.color = color

      const read = computed.color

      /* 令牌缺失时浏览器交回空串或父级继承色 —— 画出来是一整幅错色，不如当场判不变量。 */
      invariant(read !== '' && read !== 'rgba(0, 0, 0, 0)', `diagram ink unavailable: ${slot}`)

      /*
       * 画一个像素再读它：交回来的一定是 sRGB 通道，oklch / color() 到这里都被解成了
       * 具体数值。mermaid 收值时会再跑一遍 tinycolor，现代写法它不认。
       */
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = read
      context.fillRect(0, 0, 1, 1)

      const pixel = context.getImageData(0, 0, 1, 1).data
      const [red, green, blue, alpha] = [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 255]

      inks[slot] =
        alpha === 255
          ? `rgb(${red}, ${green}, ${blue})`
          : `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`
    }
  } finally {
    probe.remove()
  }

  return inks as DiagramInks
}

/*
 * mindmap 的分支配色。
 *
 * 节点上的 class 是 section-0 … section-10（一级分支的序号，更深一层继承它），mermaid 为
 * 每一档生成一条 `#id .section-N rect{fill:…}`；这里的选择器多带一个类才压得住它 —— 两边
 * 同样带 #id 前缀，胜负全在多出来的那一个 .mindmap-node / .edge 上（少一个，配色就静默
 * 回到纯黑）。
 */
const MINDMAP_SECTIONS = 11

function mindmapCss(): string {
  const shapes = (selector: string) =>
    ['rect', 'path', 'circle', 'polygon'].map((shape) => `${selector} ${shape}`).join(', ')

  const rules = [`${shapes('.mindmap-node.section-root')} { fill: ${branchInk(BRANCH_CYCLE + 1)}; }`]

  for (let section = 0; section < MINDMAP_SECTIONS; section += 1) {
    const fill = branchInk((section % BRANCH_CYCLE) + 1)

    rules.push(`${shapes(`.mindmap-node.section-${section}`)} { fill: ${fill}; }`)
    rules.push(`.edge.section-edge-${section} { stroke: ${fill}; }`)
  }

  return rules.join('\n')
}

/*
 * gitGraph 的分支配色。
 *
 * 它按分支序号上色（圆点 commitN、箭头 arrowN、分支名底 labelN），颜色取自 git0…git7 ——
 * 同样是算出来的，同样落到纯黑：黑圆点、8px 宽的黑箭头、黑分支名底（截图 B08）。这里按
 * mindmap 那同一个梯子给回来。
 *
 * 连线本身不动：`.branch` 走的是 lineColor（--cp-ink-muted），那条本来就对。
 */
const GIT_BRANCHES = 12

function gitGraphCss(): string {
  const rules: string[] = []

  for (let branch = 0; branch < GIT_BRANCHES; branch += 1) {
    const fill = branchInk((branch % BRANCH_CYCLE) + 1)

    /*
     * highlight 那一颗（merge 的外框）取前景墨本身：它就是「与内圈对照」的那一格，两圈
     * 同色会把它读成一颗普通提交。
     */
    rules.push(`.commit.commit${branch} { fill: ${fill}; stroke: ${fill}; }`)
    rules.push(`.commit.commit-highlight${branch} { fill: var(--ui-foreground); stroke: var(--ui-foreground); }`)
    rules.push(`.arrow.arrow${branch} { stroke: ${fill}; }`)
    rules.push(`.branchLabelBkg.label${branch} { fill: ${fill}; }`)
  }

  return rules.join('\n')
}

/** 与 themeVariables 一起交给引擎：这些部位的颜色压的是图自己那份样式表。 */
export const DIAGRAM_CSS = [mindmapCss(), gitGraphCss()].join('\n')
