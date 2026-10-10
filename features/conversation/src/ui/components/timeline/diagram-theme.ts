/*
 * mermaid 的 `base` 主题是唯一一套把颜色交出来的主题：`themeVariables` 里的每个键都是
 * 画布上的一个部位。代价是它只认具体颜色（官方用 tinycolor 解析每个值，喂 `var(--x)` 会
 * 当场抛 Unsupported color format），而本仓的颜色只以设计令牌存在，令牌求值后还可能停在
 * oklch() / color() 这类现代写法上 —— 所以这里有两次归一：先经探针元素过一遍样式引擎把
 * 令牌求值，再用 1×1 的画布读回实际像素，交出去的永远是 rgb()/rgba()。
 *
 * 取色一律读语义令牌，不写字面值：深浅两套主题各自成立，换主题时重新解析一次即可。
 */

import { invariant } from '@poietica/foundation'

/*
 * 面板上真正会被用到的部位。键是 mermaid 的 themeVariables 名，值是设计令牌。
 *
 * 节点面取 --ui-secondary：它是卡面那一级，深色下是压在地色上的一层灰（比 #181818 抬
 * 一档），浅色下是比白底沉一档的灰。读起来是「一张卡片」而不是「一块高亮」—— 流程图长在
 * 对话里，不该比正文更抢眼。节点框取 --ui-popover-trigger-frame，是这套设计里容器的边
 * 那一档；文字取 --cp-timeline-body-ink，与正文同一墨色。
 */
const INKS = {
  background: 'transparent',
  clusterBkg: '--ui-secondary',
  clusterBorder: '--ui-divider',
  edgeLabelBackground: '--ui-background',
  lineColor: '--cp-ink-muted',
  mainBkg: '--ui-secondary',
  primaryBorderColor: '--ui-popover-trigger-frame',
  primaryColor: '--ui-secondary',
  primaryTextColor: '--cp-timeline-body-ink',
  secondaryColor: '--ui-secondary',
  tertiaryColor: '--ui-secondary',
  textColor: '--cp-timeline-body-ink',
} as const

export type DiagramInks = Record<keyof typeof INKS, string>

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
    for (const [slot, token] of Object.entries(INKS)) {
      if (token === 'transparent') {
        inks[slot] = 'transparent'
        continue
      }

      probe.style.color = `var(${token})`

      const read = computed.color

      /* 令牌缺失时浏览器交回空串或父级继承色 —— 画出来是一整幅错色，不如当场判不变量。 */
      invariant(read !== '' && read !== 'rgba(0, 0, 0, 0)', `diagram ink unavailable: ${token}`)

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
