import { INTELLIGENT_UI_TWEAK_CONTROLS_MAX, INTELLIGENT_UI_TWEAK_OPTIONS_MAX } from '../contract'

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
  readonly html: string
  readonly bare: boolean
  readonly wide: boolean
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

const DEFAULT_TITLE = '界面'

function argsBag(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

/**
 * 参数还在流：到此为止的那一份（html 可能只有前半截、也可能还没开始）。参数按 title → wide → bare → html
 * 的顺序声明（core/tool.ts），所以写到 html 时这三项通常已经定了。
 */
export function viewDraftOf(args: unknown): ViewArgs {
  const bag = argsBag(args)
  return {
    title: (text(bag.title) ?? DEFAULT_TITLE).slice(0, 80),
    html: typeof bag.html === 'string' ? bag.html : '',
    bare: bag.bare === true,
    wide: bag.wide === true,
  }
}

/** 参数定了：html 必须是非空字符串；模型写坏了 → null，卡片画失败 */
export function viewArgsOf(args: unknown): ViewArgs | null {
  const draft = viewDraftOf(args)
  return text(draft.html) === undefined ? null : draft
}

/** 参数还在流时也想先把标题印出来 */
export function viewTitleOf(args: unknown): string {
  return text(argsBag(args).title) ?? DEFAULT_TITLE
}

/** html 界面的高度上限：不再封顶 80vh（内层滚动在对话里很难用），只防界面写坏了无限长 */
export const VIEW_HEIGHT_MAX = 10_000

export type TweakValue = number | string | boolean

interface TweakBase {
  readonly key: string
  readonly label: string
}

/** 一个调整控件：value 是界面登记时给的默认值（「重置」回到它） */
export type TweakControl =
  | (TweakBase & {
      readonly type: 'range'
      readonly min: number
      readonly max: number
      readonly step: number
      readonly unit: string
      readonly value: number
    })
  | (TweakBase & { readonly type: 'color'; readonly value: string })
  | (TweakBase & { readonly type: 'toggle'; readonly value: boolean })
  | (TweakBase & {
      readonly type: 'select'
      readonly options: readonly { readonly value: string; readonly label: string }[]
      readonly value: string
    })

/** 界面登记的一组控件；values 是当前值（可能是从状态里还原的） */
export interface TweakGroup {
  readonly id: number
  readonly label: string
  readonly controls: readonly TweakControl[]
  readonly values: Readonly<Record<string, TweakValue>>
}

export type FrameMessage =
  | { readonly type: 'height'; readonly height: number }
  | {
      readonly type: 'state'
      readonly model: string | null
      readonly view: string | null
      readonly tweaks: string | null
    }
  | { readonly type: 'tweak'; readonly op: 'register'; readonly group: TweakGroup }
  | { readonly type: 'tweak'; readonly op: 'dispose'; readonly id: number }
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
  const tweaks = jsonText(bag.tweaks ?? null)
  return model === undefined || view === undefined || tweaks === undefined
    ? null
    : { type: 'state', model, view, tweaks }
}

const TWEAK_KEY = /^[A-Za-z0-9_.-]{1,40}$/
const COLOR = /^#[0-9a-f]{6}$/

function labelOf(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 值收进控件的合法范围；收不进就是 undefined（调用方回落到默认值） */
export function coerceTweak(control: TweakControl, value: unknown): TweakValue | undefined {
  switch (control.type) {
    case 'range':
      return finite(value) ? Math.min(control.max, Math.max(control.min, value)) : undefined
    case 'color':
      return typeof value === 'string' && COLOR.test(value.toLowerCase()) ? value.toLowerCase() : undefined
    case 'toggle':
      return typeof value === 'boolean' ? value : undefined
    case 'select':
      return control.options.some((option) => option.value === value) ? (value as string) : undefined
  }
}

type ControlHead = { readonly key: string; readonly label: string }

function rangeOf(head: ControlHead, bag: Record<string, unknown>): TweakControl | null {
  const { min, max, step, value } = bag
  if (!(finite(min) && finite(max) && finite(step) && finite(value) && max > min && step > 0)) return null
  const unit = labelOf(bag.unit, 8) ?? ''
  return { type: 'range', ...head, min, max, step, unit, value: Math.min(max, Math.max(min, value)) }
}

function optionOf(option: unknown): { value: string; label: string } | null {
  const entry = typeof option === 'object' && option !== null ? (option as Record<string, unknown>) : {}
  const value = labelOf(entry.value, 100)
  const label = labelOf(entry.label, 60)
  return value === null || label === null ? null : { value, label }
}

function selectOf(head: ControlHead, bag: Record<string, unknown>): TweakControl | null {
  if (!Array.isArray(bag.options) || bag.options.length === 0) return null
  if (bag.options.length > INTELLIGENT_UI_TWEAK_OPTIONS_MAX) return null
  const options: { value: string; label: string }[] = []
  for (const raw of bag.options as unknown[]) {
    const option = optionOf(raw)
    if (option === null) return null
    options.push(option)
  }
  const value = options.find((option) => option.value === bag.value)?.value
  return value === undefined ? null : { type: 'select', ...head, options, value }
}

/* 外壳那边已经校验过一遍；这里再来一遍：外壳和界面在同一个全局里，界面改了内建原型，外壳交来的东西就不可信 */
function controlOf(raw: unknown): TweakControl | null {
  if (typeof raw !== 'object' || raw === null) return null
  const bag = raw as Record<string, unknown>
  const key = typeof bag.key === 'string' && TWEAK_KEY.test(bag.key) ? bag.key : null
  const label = labelOf(bag.label, 60)
  if (key === null || label === null) return null
  const head = { key, label }
  switch (bag.type) {
    case 'range':
      return rangeOf(head, bag)
    case 'color':
      return typeof bag.value === 'string' && COLOR.test(bag.value)
        ? { type: 'color', ...head, value: bag.value }
        : null
    case 'toggle':
      return typeof bag.value === 'boolean' ? { type: 'toggle', ...head, value: bag.value } : null
    case 'select':
      return selectOf(head, bag)
    default:
      return null
  }
}

function groupOf(bag: Record<string, unknown>): TweakGroup | null {
  const id = bag.id
  const label = labelOf(bag.label, 60)
  if (!(typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || label === null || label === '') return null
  if (!Array.isArray(bag.controls) || bag.controls.length === 0) return null
  if (bag.controls.length > INTELLIGENT_UI_TWEAK_CONTROLS_MAX) return null
  const controls: TweakControl[] = []
  for (const raw of bag.controls as unknown[]) {
    const control = controlOf(raw)
    if (control === null || controls.some((other) => other.key === control.key)) return null
    controls.push(control)
  }
  const given = typeof bag.values === 'object' && bag.values !== null ? (bag.values as Record<string, unknown>) : {}
  const values: Record<string, TweakValue> = {}
  for (const control of controls) values[control.key] = coerceTweak(control, given[control.key]) ?? control.value
  return { id, label, controls, values }
}

function tweakOf(bag: Record<string, unknown>): FrameMessage | null {
  if (bag.op === 'register') {
    const group = groupOf(bag)
    return group === null ? null : { type: 'tweak', op: 'register', group }
  }
  if (bag.op === 'dispose' && typeof bag.id === 'number' && Number.isSafeInteger(bag.id)) {
    return { type: 'tweak', op: 'dispose', id: bag.id }
  }
  return null
}

function saidOf(type: 'send' | 'draft', bag: Record<string, unknown>, gesture: boolean): FrameMessage | null {
  const said = typeof bag.text === 'string' ? bag.text.trim() : ''
  return said === '' ? null : { type, text: said.slice(0, VIEW_TEXT_MAX), gesture }
}

/**
 * 外壳经私有端口发来的消息：只认这七种，字段类型不对就当没收到。
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
    case 'tweak':
      return tweakOf(bag)
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
