/*
 * 设计令牌收敛用的颜色等值折算器（一次性维护脚本）。
 *
 * 判定规则（style-audit 口径）：一种颜色写法折算成「8 位 sRGB + 8 位 alpha」的键，
 * 键相同即渲染同值（rgb(0 0 0 / 3.9%) 与 #0000000a 同键）。预合成的实色与半透明色
 * 只在特定底色上相等，本工具不做底色合成，两类写法键必不同——写法本身是角色的一部分。
 *
 * oklch 按 CSS Color 4 的定义折算到 sRGB；超出色域的通道按 Chromium 的行为钳到 [0,1]
 * 并在 stderr 提示。color-mix 按 premultiplied alpha 混合（与 transparent 混只改 alpha，
 * 与插值空间无关；两个不透明色混色时插值空间会改值，所以 in srgb 与 in oklab 各自算键）。
 *
 * 用法：
 *   bun scripts/color.ts '<颜色写法>'…          打印每个写法的键
 *   bun scripts/color.ts --eq '<a>' '<b>' …     全部同键退出码 0，否则 1
 */

interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

const NAMED: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
}

/** 按 Chromium 的行为把超界值钳到 [0,1]；越界一次记一条提示。 */
function clampUnit(value: number, what: string, notes: string[]): number {
  // 色域边界上的浮点尘埃（1e-16 量级）不算越界，否则正常的 oklch 折返会刷提示。
  if (value >= -1e-9 && value <= 1 + 1e-9) return Math.min(1, Math.max(0, value))
  notes.push(`${what} 越出 [0,1]（${value.toFixed(4)}），按 Chromium 行为钳位`)
  return Math.min(1, Math.max(0, value))
}

function parseNumber(token: string, what: string): number {
  const value = Number.parseFloat(token)
  if (!Number.isFinite(value)) throw new Error(`${what} 不是数字：${token}`)
  return value
}

function requirePart<T>(value: T | undefined, what: string, whole: string): T {
  if (value === undefined) throw new Error(`${what} 缺字段：${whole}`)
  return value
}

function fromHex(hex: string): Rgba {
  let body = hex.slice(1)
  if (body.length === 3 || body.length === 4) body = [...body].map((c) => c + c).join('')
  if (body.length !== 6 && body.length !== 8) throw new Error(`不认识的 hex 写法：${hex}`)
  const byte = (offset: number): number => {
    const value = Number.parseInt(body.slice(offset, offset + 2), 16)
    if (!Number.isInteger(value)) throw new Error(`不认识的 hex 写法：${hex}`)
    return value / 255
  }
  return { r: byte(0), g: byte(2), b: byte(4), a: body.length === 8 ? byte(6) : 1 }
}

function parseAlpha(token: string): number {
  return token.endsWith('%') ? parseNumber(token.slice(0, -1), 'alpha') / 100 : parseNumber(token, 'alpha')
}

function fromRgb(args: string, notes: string[]): Rgba {
  const [colorPart = '', alphaPart] = args.split('/')
  const parts = colorPart
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
  // 旧语法 rgba(r, g, b, a) 没有 `/`，alpha 是第 4 个参数。
  const legacyAlpha = alphaPart === undefined && parts.length === 4
  if (parts.length !== 3 && !legacyAlpha) throw new Error(`不认识的 rgb 写法：rgb(${args})`)
  const channel = (index: number, what: string): number => {
    const token = requirePart(parts[index], what, `rgb(${args})`)
    const raw = token.endsWith('%') ? (parseNumber(token.slice(0, -1), what) / 100) * 255 : parseNumber(token, what)
    return clampUnit(raw / 255, what, notes)
  }
  const alphaTok = alphaPart?.trim() ?? (legacyAlpha ? parts[3] : undefined)
  const alpha = alphaTok === undefined ? 1 : clampUnit(parseAlpha(alphaTok), 'alpha', notes)
  return { r: channel(0, 'R'), g: channel(1, 'G'), b: channel(2, 'B'), a: alpha }
}

function srgbTransfer(channel: number): number {
  const v = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  return Math.min(1, Math.max(0, v))
}

/** OKLab → sRGB；越界通道按 Chromium 钳位并记提示。 */
function oklabToRgba([L, a, b]: readonly [number, number, number], alpha: number, notes: string[]): Rgba {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const linR = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const linG = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const linB = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return {
    r: srgbTransfer(clampUnit(linR, 'R', notes)),
    g: srgbTransfer(clampUnit(linG, 'G', notes)),
    b: srgbTransfer(clampUnit(linB, 'B', notes)),
    a: alpha,
  }
}

function fromOklch(args: string, notes: string[]): Rgba {
  const [colorPart = '', alphaPart] = args.split('/')
  const [lTok, cTok, hTok] = colorPart
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
  const L =
    lTok === undefined
      ? undefined
      : lTok.endsWith('%')
        ? parseNumber(lTok.slice(0, -1), 'L') / 100
        : parseNumber(lTok, 'L')
  const C =
    cTok === undefined
      ? undefined
      : cTok.endsWith('%')
        ? parseNumber(cTok.slice(0, -1), 'C') / 100
        : parseNumber(cTok, 'C')
  const H = hTok === undefined ? undefined : (parseNumber(hTok, 'H') * Math.PI) / 180
  if (L === undefined || C === undefined || H === undefined) throw new Error(`不认识的 oklch 写法：oklch(${args})`)
  const alpha = alphaPart === undefined ? 1 : clampUnit(parseAlpha(alphaPart.trim()), 'alpha', notes)
  return oklabToRgba([L, C * Math.cos(H), C * Math.sin(H)], alpha, notes)
}

function toLinearSrgb(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function rgbaToOklab(c: Rgba): [number, number, number] {
  const r = toLinearSrgb(c.r)
  const g = toLinearSrgb(c.g)
  const b = toLinearSrgb(c.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** 按顶层逗号切分（括号嵌套不切）。 */
function splitTopLevel(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current)
  return out
}

interface MixComponent {
  readonly spec: string
  readonly pct: number | undefined
}

function parseMixComponent(part: string): MixComponent {
  const match = /^(.*?)(?:\s+([\d.]+%))?\s*$/.exec(part.trim())
  if (match === null) throw new Error(`不认识的 color-mix 分量：${part}`)
  const pctTok = match[2]
  return {
    spec: match[1] ?? '',
    pct: pctTok === undefined ? undefined : parseNumber(pctTok.slice(0, -1), '权重') / 100,
  }
}

function mixColorMix(args: string, notes: string[]): Rgba {
  const inMatch = /^in\s+([a-z-]+)\s*,\s*(.+)$/i.exec(args.trim())
  if (!inMatch) throw new Error(`不认识的 color-mix 写法：color-mix(${args})`)
  const space = requirePart(inMatch[1], '插值空间', `color-mix(${args})`).toLowerCase()
  if (space !== 'srgb' && space !== 'oklab') {
    throw new Error(`只支持 in srgb / in oklab，收到 in ${space}（其余插值空间先按需补）`)
  }
  // 两个分量各自带可选百分比；只给一个时另一个补足 100%，都不给时各半（CSS Color 5 口径）。
  const comma = splitTopLevel(requirePart(inMatch[2], '分量', `color-mix(${args})`))
  if (comma.length !== 2) throw new Error(`color-mix 只支持两个分量，收到 ${comma.length} 个`)
  const first = parseMixComponent(requirePart(comma[0], '第一个分量', `color-mix(${args})`))
  const second = parseMixComponent(requirePart(comma[1], '第二个分量', `color-mix(${args})`))
  const p1 = first.pct ?? (second.pct === undefined ? 0.5 : 1 - second.pct)
  const p2 = second.pct ?? 1 - p1
  const wa = p1 / (p1 + p2)
  const wb = 1 - wa
  const A = parseColor(first.spec, notes)
  const B = parseColor(second.spec, notes)
  const alpha = A.a * wa + B.a * wb
  // premultiplied：颜色通道按 alpha 加权，再除回混合后的 alpha。
  const blend = (x: number, y: number): number => (alpha === 0 ? 0 : (x * A.a * wa + y * B.a * wb) / alpha)
  if (space === 'srgb') {
    return { r: blend(A.r, B.r), g: blend(A.g, B.g), b: blend(A.b, B.b), a: alpha }
  }
  // in oklab：把两端折到 oklab 再按通道插值（两端的 oklab 由本工具的 sRGB 键反解，
  // 对已是 oklch 的输入会经过一次 sRGB 钳位——与 Chromium 的成色差距在色域内为零）。
  const aLab = rgbaToOklab(A)
  const bLab = rgbaToOklab(B)
  const mixed: [number, number, number] = [blend(aLab[0], bLab[0]), blend(aLab[1], bLab[1]), blend(aLab[2], bLab[2])]
  return oklabToRgba(mixed, alpha, notes)
}

function parseColor(spec: string, notes: string[]): Rgba {
  const s = spec.trim()
  if (s.startsWith('#')) return fromHex(s)
  const fn = /^(rgb|rgba|oklch|color-mix)\((.*)\)$/i.exec(s)
  if (fn) {
    const name = fn[1]?.toLowerCase()
    const body = fn[2] ?? ''
    if (name === 'rgb' || name === 'rgba') return fromRgb(body, notes)
    if (name === 'oklch') return fromOklch(body, notes)
    return mixColorMix(body, notes)
  }
  const named = NAMED[s]
  if (named !== undefined) return fromHex(named)
  throw new Error(`不认识的颜色写法：${s}`)
}

function toByte(channel: number): string {
  const value = Math.round(channel * 255)
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`通道值无法折算成字节：${channel}`)
  return value.toString(16).padStart(2, '0')
}

/** 键 = 8 位 sRGB + 8 位 alpha。 */
export function colorKey(spec: string, notes: string[] = []): string {
  const { r, g, b, a } = parseColor(spec, notes)
  return `${toByte(r)}${toByte(g)}${toByte(b)}${toByte(a)}`
}

if (import.meta.main) {
  /* CLI 输出走 process.stdout/stderr：本仓禁 console.*，一次性脚本不豁免。 */
  const args = process.argv.slice(2)
  const eqMode = args[0] === '--eq'
  const specs = eqMode ? args.slice(1) : args
  if (specs.length === 0) {
    process.stderr.write('用法：bun scripts/color.ts [ --eq ] <颜色写法>…\n')
    process.exit(2)
  }
  const notes: string[] = []
  const keys = specs.map((spec) => ({ spec, key: colorKey(spec, notes) }))
  for (const { spec, key } of keys) process.stdout.write(`${key}  ${spec}\n`)
  for (const note of notes) process.stderr.write(`${note}\n`)
  if (eqMode) {
    const [head, ...rest] = keys
    const same = head !== undefined && rest.every((k) => k.key === head.key)
    process.stdout.write(`${same ? '同键：渲染同值' : '不同键：渲染不同值'}\n`)
    process.exit(same ? 0 : 1)
  }
}
