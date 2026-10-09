import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { LayoutToken, useService } from '@poietica/ui-kernel'
import { Globe } from 'lucide-react'
import type { ReactNode } from 'react'
import './browser-tool-card.css'

/*
 * agent 那条线的工具卡片（07 页 §12E 的 `toolCallRenderers`）。
 *
 * 折叠行那句「浏览器 · <动作> <目标>」与 legacy 的 omp 浏览器视图同一套词汇
 * （`apps/desktop` 的 BROWSER_ACTIONS：调用标签页 / 关闭标签页 / 打开 / 执行脚本 /
 * 列出标签页），所以同一件事在两处读起来是同一句话。新架构多出来的两件是 07 页点名的：
 * 有截图结果时画缩略图，以及卡片上那枚「在面板中查看」。
 *
 * omp 的产出形状：截图落在 `result.details.screenshots`，每一项是
 * `{dest, mimeType, bytes, width, height}` —— 只有落盘信息，没有内联数据。缩略图优先用
 * 产出正文里带回的 image 块（relay 能内联时才有），拿不到就退回文件名与尺寸：画一张
 * 灰色的空图比编一份假位图诚实。
 */

const BROWSER_ACTIONS: Readonly<Record<string, string>> = {
  call: '调用标签页',
  close: '关闭标签页',
  open: '打开',
  run: '执行脚本',
  tabs: '列出标签页',
}

const PANEL_ID = 'browser.panel'

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function pick(value: unknown, key: string): string | null {
  const raw = bag(value)[key]

  return typeof raw === 'string' ? raw : null
}

function oneLine(value: string): string {
  const cut = value.indexOf('\n')
  const said = (cut === -1 ? value : value.slice(0, cut)).trim()

  return said.length > 120 ? `${said.slice(0, 120)}…` : said
}

function join(...parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' ')
}

interface Screenshot {
  readonly dest: string
  readonly width: number | null
  readonly height: number | null
}

function screenshotsOf(details: unknown): readonly Screenshot[] {
  const raw = bag(details).screenshots

  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap((item) => {
    const record = bag(item)
    const dest = typeof record.dest === 'string' ? record.dest : null

    if (dest === null) {
      return []
    }

    return [
      {
        dest,
        width: typeof record.width === 'number' ? record.width : null,
        height: typeof record.height === 'number' ? record.height : null,
      },
    ]
  })
}

/** 产出正文里内联的图片（relay 带回来时才有）：只认 data URL，别的一律不当位图。 */
function inlineImagesOf(result: unknown): readonly { src: string; alt: string }[] {
  const content = bag(result).content

  if (!Array.isArray(content)) {
    return []
  }

  return content.flatMap((part) => {
    const record = bag(part)

    if (record.type === 'image' && typeof record.data === 'string') {
      const mime = typeof record.mimeType === 'string' ? record.mimeType : 'image/png'

      return [{ src: `data:${mime};base64,${record.data}`, alt: '浏览器截图' }]
    }

    if (record.type === 'content') {
      const inner = bag(record.content)

      if (inner.type === 'image' && typeof inner.data === 'string') {
        const mime = typeof inner.mimeType === 'string' ? inner.mimeType : 'image/png'

        return [{ src: `data:${mime};base64,${inner.data}`, alt: '浏览器截图' }]
      }
    }

    return []
  })
}

export function BrowserToolCard({ args, result, status }: ToolCallRendererProps): ReactNode {
  const layout = useService(LayoutToken)
  const action = pick(args, 'action') ?? ''
  const name = pick(args, 'name') ?? 'main'
  const url = pick(args, 'url') ?? pick(bag(result).details, 'url')
  const place = url ?? name
  const head = BROWSER_ACTIONS[action] ?? action
  const shots = screenshotsOf(bag(result).details)
  const inline = inlineImagesOf(result)

  return (
    <section className="timeline-tool browser-tool" data-browser-tool="">
      <div className="browser-tool__row">
        <Globe aria-hidden className="timeline-row__icon" />
        <span className="timeline-row__label">{join('浏览器', head, place) || '浏览器'}</span>
        {status === 'running' ? <span className="browser-tool__status">进行中</span> : null}
        {status === 'failed' ? <span className="browser-tool__status browser-tool__status--failed">失败</span> : null}
      </div>

      {shots.length > 0 || inline.length > 0 ? (
        <div className="browser-tool__shots">
          {inline.map((image) => (
            <img alt={image.alt} className="browser-tool__shot" key={image.src} src={image.src} />
          ))}
          {shots.map((shot) => (
            <span className="browser-tool__shot browser-tool__shot--file" key={shot.dest} title={shot.dest}>
              <span className="browser-tool__shot-name">{oneLine(shot.dest)}</span>
              {shot.width !== null && shot.height !== null ? (
                <span className="browser-tool__shot-size">
                  {String(shot.width)}×{String(shot.height)}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      <div className="browser-tool__actions">
        <button
          className="browser-tool__open"
          onClick={() => {
            layout.openPanel('right', PANEL_ID)
          }}
          type="button"
        >
          在面板中查看
        </button>
      </div>
    </section>
  )
}
