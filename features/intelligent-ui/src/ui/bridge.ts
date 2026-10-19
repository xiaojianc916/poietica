/* 智能界面在 UI 这一侧的纯逻辑（端口会话在 frame-session.ts，DOM 与 React 在 card.tsx；这里不碰，便于单测）。 */

/** 与 contract 的 INTELLIGENT_UI_TOKEN_NAMES 必须一致（有单测钉住） */
export const TOKEN_SOURCES: Readonly<Record<string, string>> = {
  '--color-text': '--cp-timeline-body-ink',
  '--color-text-muted': '--cp-ink-muted',
  '--color-text-subtle': '--cp-ink-subtle',
  '--color-surface': '--cp-timeline-output-surface',
  '--color-surface-raised': '--ui-card',
  '--color-surface-sunken': '--ui-sunken',
  '--color-border': '--cp-edge',
  '--color-border-strong': '--ui-input',
  '--color-hover': '--ui-control-hover',
  '--color-accent': '--cp-accent',
  '--color-accent-text': '--cp-accent-foreground',
  '--color-link': '--cp-timeline-link-ink',
  '--color-focus': '--ui-ring',
  '--color-success': '--ui-success',
  '--color-warning': '--ui-warning',
  '--color-danger': '--ui-destructive',
  '--font-sans': '--ui-font-sans',
  '--font-mono': '--ui-font-mono',
  '--text-base': '--ui-prose-size',
  '--radius-sm': '--ui-radius-md',
  '--radius': '--ui-radius-lg',
  '--radius-lg': '--ui-radius-xl',
  '--shadow-sm': '--ui-shadow-sm',
  '--shadow': '--ui-shadow-md',
}

/* 令牌 → `:root{…}`。read 给的是 getComputedStyle 的计算值（var() 已代入）。
 * 值里出现 < > { } ; 一律丢掉这一格：它们只可能把样式表拆开。 */
export function tokenCss(read: (token: string) => string): string {
  const declarations: string[] = []
  for (const [name, token] of Object.entries(TOKEN_SOURCES)) {
    const value = read(token).trim()
    if (value === '' || /[<>{};]/.test(value)) continue
    declarations.push(`${name}:${value}`)
  }
  return `:root{${declarations.join(';')}}`
}

export interface ViewArgs {
  readonly title: string
  readonly html?: string
  readonly url?: string
  readonly height?: number
  readonly bare: boolean
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

const DEFAULT_TITLE = '界面'

/** 参数还在流、模型写坏了 → null，卡片画「准备中」或失败 */
export function viewArgsOf(args: unknown): ViewArgs | null {
  if (typeof args !== 'object' || args === null) return null
  const bag = args as Record<string, unknown>
  const html = text(bag.html)
  const url = text(bag.url)
  if ((html === undefined) === (url === undefined)) return null
  const height = typeof bag.height === 'number' && Number.isFinite(bag.height) ? Math.round(bag.height) : undefined
  return {
    title: (text(bag.title) ?? DEFAULT_TITLE).slice(0, 80),
    ...(html === undefined ? {} : { html }),
    ...(url === undefined ? {} : { url }),
    ...(height === undefined ? {} : { height: Math.min(Math.max(height, 80), 2000) }),
    bare: bag.bare === true,
  }
}

/** 参数还在流时也想先把标题印出来 */
export function viewTitleOf(args: unknown): string {
  return typeof args === 'object' && args !== null
    ? (text((args as Record<string, unknown>).title) ?? DEFAULT_TITLE)
    : DEFAULT_TITLE
}

/** html 界面的高度上限：不再封顶 80vh（内层滚动在对话里很难用），只防界面写坏了无限长 */
export const VIEW_HEIGHT_MAX = 10_000

export type FrameMessage =
  | { readonly type: 'height'; readonly height: number }
  | { readonly type: 'state'; readonly model: string | null; readonly view: string | null }
  | { readonly type: 'send'; readonly text: string; readonly gesture: boolean }
  | { readonly type: 'draft'; readonly text: string; readonly gesture: boolean }
  | { readonly type: 'open'; readonly url: string; readonly gesture: boolean }
  | { readonly type: 'error'; readonly message: string }

/** 界面是别人写的代码，不能让它塞一本书进来 */
export const VIEW_TEXT_MAX = 4000

function jsonText(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function heightOf(bag: Record<string, unknown>): FrameMessage | null {
  return typeof bag.height === 'number' && Number.isFinite(bag.height) && bag.height >= 0
    ? { type: 'height', height: Math.min(Math.ceil(bag.height), VIEW_HEIGHT_MAX) }
    : null
}

function stateOf(bag: Record<string, unknown>): FrameMessage | null {
  const model = jsonText(bag.model)
  const view = jsonText(bag.view)
  return model === undefined || view === undefined ? null : { type: 'state', model, view }
}

function saidOf(type: 'send' | 'draft', bag: Record<string, unknown>, gesture: boolean): FrameMessage | null {
  const said = typeof bag.text === 'string' ? bag.text.trim() : ''
  return said === '' ? null : { type, text: said.slice(0, VIEW_TEXT_MAX), gesture }
}

/**
 * 外壳经私有端口发来的消息：只认这六种，字段类型不对就当没收到。
 * gesture 是小桥的证词（这次调用前 5 秒内有一次没用过的真实操作）；UI 还要再叠父窗口的 userActivation。
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const bag = data as Record<string, unknown>
  const gesture = bag.gesture === true
  switch (bag.type) {
    case 'height':
      return heightOf(bag)
    case 'state':
      return stateOf(bag)
    case 'send':
    case 'draft':
      return saidOf(bag.type, bag, gesture)
    case 'open':
      return typeof bag.url === 'string' ? { type: 'open', url: bag.url, gesture } : null
    case 'error':
      return typeof bag.message === 'string' ? { type: 'error', message: bag.message.slice(0, 500) } : null
    default:
      return null
  }
}

/** 只放 http(s) 与 mailto */
export function externalUrlOf(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null
  } catch {
    return null
  }
}

/** 结果可能是字符串、{text}、{content:[{type:'text',text}]}，或带 message/error */
export function failureOf(result: unknown): string {
  if (typeof result === 'string' && result.trim() !== '') return result
  if (typeof result === 'object' && result !== null) {
    const bag = result as Record<string, unknown>
    for (const key of ['message', 'error', 'text']) {
      const value = bag[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    if (Array.isArray(bag.content)) {
      const texts = bag.content.flatMap((part: unknown) =>
        typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string'
          ? [(part as Record<string, unknown>).text as string]
          : [],
      )
      if (texts.length > 0) return texts.join('\n')
    }
  }
  return '界面没能显示'
}

/** url 来源的地址条：去掉协议，留 host:port 与路径 */
export function addressOf(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}`
  } catch {
    return raw
  }
}
