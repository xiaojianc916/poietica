/* mermaid 只认具体颜色（喂 `var(--x)` 当场抛错），而本仓颜色是设计令牌、求值后可能停在 oklch()：所以先过样式引擎求值，再用 1×1 画布读回像素。
   cScale 一族与 git0…git7 拿到值后会被再压暗 25 格，深色下令牌本就在 oklch(0.19…) 一档、减 25 夹到 0 就是整张纯黑 ——
   这些走 themeCSS 直接写令牌（它会被拼进图自己的 <style>），选择器多带一个类即可，不用 !important。 */

import { invariant } from '@poietica/foundation'

/* 一档兑墨：前景墨按百分比兑进节点面，深浅两套主题里都是「越兑越显眼」。 */
function ink(percent: number): string {
  return `color-mix(in oklab, var(--ui-foreground) ${percent}%, var(--ui-secondary))`
}

/* 一条分支比上一条重一档，三档一循环。 */
const BRANCH_STEP = 10
const BRANCH_CYCLE = 3

function branchInk(step: number): string {
  return ink(BRANCH_STEP * step)
}

/* 键是 mermaid 的 themeVariables 名；节点面取 --ui-secondary，图在对话里不该比正文抢眼。 */
export const DIAGRAM_INKS = {
  background: 'transparent',
  clusterBkg: 'var(--ui-secondary)',
  clusterBorder: 'var(--ui-divider)',
  edgeLabelBackground: 'var(--ui-background)',
  lineColor: 'var(--cp-ink-muted)',
  mainBkg: 'var(--ui-secondary)',

  /* 饼图十二个扇区：mermaid 的 pie 只有 themeVariables 这一个口子（图例那几格是内联 style，CSS 够不到）。
     档位按平方根排开（48·√(n/11)）：十二档只能挤在 0～48 这个还读得清字的区间，等距会让三四片饼糊成一片。 */
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
  /* 扇区之间的缝留地色，最外那一圈取区域线那一档墨。 */
  pieOuterStrokeColor: 'var(--ui-divider)',
  pieStrokeColor: 'var(--ui-background)',

  primaryBorderColor: 'var(--ui-popover-trigger-frame)',
  primaryColor: 'var(--ui-secondary)',
  primaryTextColor: 'var(--cp-timeline-body-ink)',

  /* ER 表隔行底：默认算式（主色提亮 75 格）深浅两套主题都算出近白，这里奇数行取节点面、偶数行兑一档墨。 */
  rowEven: branchInk(1),
  rowOdd: branchInk(0),

  secondaryColor: 'var(--ui-secondary)',
  tertiaryColor: 'var(--ui-secondary)',
  textColor: 'var(--cp-timeline-body-ink)',
} as const

export type DiagramInks = Record<keyof typeof DIAGRAM_INKS, string>

/* 一像素就够：要的只是「浏览器把这个颜色算成了哪几个通道」。 */
function rasterizer(): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas')

  canvas.width = 1
  canvas.height = 1

  return canvas.getContext('2d', { willReadFrequently: true })
}

/* 探针挂在正文里、与图同一个祖先，读到的就是这张图此刻该用的那一套。 */
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

      /* 画一个像素再读它：交回来的一定是 sRGB 通道，oklch / color() 都被解成具体数值（mermaid 收值时会再跑一遍 tinycolor，现代写法它不认）。 */
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

/* mindmap 分支配色：节点 class 是 section-0…section-10，mermaid 为每档生成 `#id .section-N rect{fill:…}`。
   这里的选择器多带一个类才压得住它 —— 两边同样带 #id 前缀，胜负全在那多出来的 .mindmap-node / .edge 上（少一个，配色就静默回到纯黑）。 */
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

/* gitGraph 的分支配色：颜色取自 git0…git7，同样是算出来的、同样落到纯黑（黑圆点、黑箭头、黑分支名底），这里按 mindmap 那同一个梯子给回来。 */
const GIT_BRANCHES = 12

function gitGraphCss(): string {
  const rules: string[] = []

  for (let branch = 0; branch < GIT_BRANCHES; branch += 1) {
    const fill = branchInk((branch % BRANCH_CYCLE) + 1)

    /* merge 的外框取前景墨本身：它就是「与内圈对照」的那一格，两圈同色会读成一颗普通提交。 */
    rules.push(`.commit.commit${branch} { fill: ${fill}; stroke: ${fill}; }`)
    rules.push(`.commit.commit-highlight${branch} { fill: var(--ui-foreground); stroke: var(--ui-foreground); }`)
    rules.push(`.arrow.arrow${branch} { stroke: ${fill}; }`)
    rules.push(`.branchLabelBkg.label${branch} { fill: ${fill}; }`)
  }

  return rules.join('\n')
}

/** 与 themeVariables 一起交给引擎：这些部位的颜色压的是图自己那份样式表。 */
export const DIAGRAM_CSS = [mindmapCss(), gitGraphCss()].join('\n')
