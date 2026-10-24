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

function clampChannel(value: number, what: string, notes: string[]): number {
  if (value < 0 || value > 1) {
    notes.push(`${what} 越出 sRGB 色域（${value.toFixed(4)}），按 Chromium 行为钳位`)
    return Math.min(1, Math.max(0, value))
  }
  return value
}

function fromHex(hex: string, notes: string[]): Rgba {
  let body = hex.slice(1)
  if (body.length === 3 || body.length === 4) body = [...body].map((c) => c + c).join('')
  if (body.length !== 6 && body.length !== 8) throw new Error(`不认识的 hex 写法：${hex}`)
  const r = Number.parseInt(body.slice(0, 2), 16) / 255
  const g = Number.parseInt(body.slice(2, 4), 16) / 255
  const b = Number.parseInt(body.slice(4, 6), 16) / 255
  const a = body.length === 8 ? Number.parseInt(body.slice(6, 8), 16) / 255 : 1
  void notes
  return { r, g, b, a }
}

function parseAlpha(token: string): number {
  if (token.endsWith('%')) return Number.parseFloat(token) / 100
  return Number.parseFloat(token)
}

function fromRgb(args: string, notes: string[]): Rgba {
  const [colorPart, alphaPart] = args.split('/')
  const parts = colorPart
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
  // 旧语法 rgba(r, g, b, a) 没有 `/`，alpha 是第 4 个参数。
  const alphaTok = alphaPart !== undefined ? alphaPart.trim() : parts.length === 4 ? parts[3] : undefined
  const channels = (parts.length === 4 ? parts.slice(0, 3) : parts).map((p) =>
    p.endsWith('%') ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p),
  )
  if (channels.length !== 3) throw new Error(`不认识的 rgb 写法：rgb(${args})`)
  void notes
  return {
    r: channels[0] / 255,
    g: channels[1] / 255,
    b: channels[2] / 255,
    a: alphaTok === undefined ? 1 : parseAlpha(alphaTok),
  }
}

function srgbTransfer(channel: number): number {
  const v = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  return Math.min(1, Math.max(0, v))
}

function fromOklch(args: string, notes: string[]): Rgba {
  const [colorPart, alphaPart] = args.split('/')
  const [lTok, cTok, hTok] = colorPart
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
  const L = Number.parseFloat(lTok) / (lTok.endsWith('%') ? 100 : 1)
  const C = Number.parseFloat(cTok) / (cTok.endsWith('%') ? 100 : 1)
  const H = (Number.parseFloat(hTok) * Math.PI) / 180
  const a = C * Math.cos(H)
  const b = C * Math.sin(H)
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
    r: srgbTransfer(clampChannel(linR, 'R', notes)),
    g: srgbTransfer(clampChannel(linG, 'G', notes)),
    b: srgbTransfer(clampChannel(linB, 'B', notes)),
    a: alphaPart === undefined ? 1 : parseAlpha(alphaPart.trim()),
  }
}

function toLinearSrgb(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function mixColorMix(args: string, notes: string[]): Rgba {
  const inMatch = /^in\s+([a-z-]+)\s*,\s*(.+)$/i.exec(args.trim())
  if (!inMatch) throw new Error(`不认识的 color-mix 写法：color-mix(${args})`)
  const [, spaceRaw, rest] = inMatch
  const space = spaceRaw.toLowerCase()
  if (space !== 'srgb' && space !== 'oklab') {
    throw new Error(`只支持 in srgb / in oklab，收到 in ${spaceRaw}（其余插值空间先按需补）`)
  }
  // 两个分量各自带可选百分比；只给一个时另一个补足 100%，都不给时各半（CSS Color 5 口径）。
  const comma = splitTopLevel(rest)
  if (comma.length !== 2) throw new Error(`color-mix 只支持两个分量，收到 ${comma.length} 个`)
  const [first, second] = comma.map((part) => {
    const m = /^(.*?)(?:\s+([\d.]+%))?\s*$/.exec(part.trim())!
    return { spec: m[1], pct: m[2] === undefined ? undefined : Number.parseFloat(m[2]) / 100 }
  })
  const p1 = first.pct ?? (second.pct === undefined ? 0.5 : 1 - second.pct)
  const p2 = second.pct ?? 1 - p1
  const wa = p1 / (p1 + p2)
  const wb = 1 - wa
  const A = parseColor(first.spec, notes)
  const B = parseColor(second.spec, notes)
  const alpha = A.a * wa + B.a * wb
  const chan = (pick: (c: Rgba) => number): number => {
    if (alpha === 0) return 0
    return (pick(A) * A.a * wa + pick(B) * B.a * wb) / alpha
  }
  if (space === 'srgb') {
    return { r: chan((c) => c.r), g: chan((c) => c.g), b: chan((c) => c.b), a: alpha }
  }
  // in oklab：把两端折到 oklab 再按通道插值（两端的 oklab 由本工具的 sRGB 键反解，
  // 对已是 oklch 的输入会经过一次 sRGB 钳位——与 Chromium 的成色差距在色域内为零）。
  const aLab = rgbaToOklab(A)
  const bLab = rgbaToOklab(B)
  const lab = (pick: (c: [number, number, number]) => number): number =>
    (pick(aLab) * A.a * wa + pick(bLab) * B.a * wb) / alpha
  const mixed: [number, number, number] = [lab((c) => c[0]), lab((c) => c[1]), lab((c) => c[2])]
  return oklabToRgba(mixed, notes)
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

function oklabToRgba([L, a, b]: [number, number, number], notes: string[]): Rgba {
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
    r: srgbTransfer(clampChannel(linR, 'R', notes)),
    g: srgbTransfer(clampChannel(linG, 'G', notes)),
    b: srgbTransfer(clampChannel(linB, 'B', notes)),
    a: 1,
  }
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

function parseColor(spec: string, notes: string[]): Rgba {
  const s = spec.trim()
  if (s.startsWith('#')) return fromHex(s, notes)
  const fn = /^(rgb|rgba|oklch|color-mix)\((.*)\)$/i.exec(s)
  if (fn) {
    const name = fn[1].toLowerCase()
    if (name === 'rgb' || name === 'rgba') return fromRgb(fn[2], notes)
    if (name === 'oklch') return fromOklch(fn[2], notes)
    return mixColorMix(fn[2], notes)
  }
  if (NAMED[s]) return fromHex(NAMED[s], notes)
  throw new Error(`不认识的颜色写法：${s}`)
}

function toByte(channel: number): string {
  return Math.round(channel * 255)
    .toString(16)
    .padStart(2, '0')
}

/** 键 = 8 位 sRGB + 8 位 alpha。 */
export function colorKey(spec: string, notes: string[] = []): string {
  const { r, g, b, a } = parseColor(spec, notes)
  return `${toByte(r)}${toByte(g)}${toByte(b)}${toByte(a)}`
}

if (import.meta.main) {
  /* CLI 输出走 process.stdout/stderr：本仓禁 console.*，一次性脚本不豁免。 */
  const write = (line: string) => process.stdout.write(`${line}\n`)
  const writeErr = (line: string) => process.stderr.write(`${line}\n`)
  const args = process.argv.slice(2)
  const eqMode = args[0] === '--eq'
  const specs = eqMode ? args.slice(1) : args
  if (specs.length === 0) {
    writeErr('用法：bun scripts/color.ts [ --eq ] <颜色写法>…')
    process.exit(2)
  }
  const notes: string[] = []
  const keys = specs.map((spec) => ({ spec, key: colorKey(spec, notes) }))
  for (const { spec, key } of keys) write(`${key}  ${spec}`)
  for (const note of notes) writeErr(note)
  if (eqMode) {
    const same = keys.every((k) => k.key === keys[0].key)
    write(same ? '同键：渲染同值' : '不同键：渲染不同值')
    process.exit(same ? 0 : 1)
  }
}
