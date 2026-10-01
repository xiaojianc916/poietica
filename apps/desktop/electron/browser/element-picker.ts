/*
 * 元素拾取的宿主侧。token 语义的正本在 crates/browser/src/picker.rs：
 * 一次拾取只租给一个标签一个自增 token，回调必须带着当前租约才算数 —— 页面上的旧面板
 * 晚一步回话时，那份载荷已经属于上一次拾取，收下就会把别人的元素塞进这一轮。
 *
 * 注入脚本不进这个文件：它的正文是 apps/desktop/src/browser/element-picker-runtime.ts，
 * 与构建期生成的那份一样用 bun build 打成 dist-electron/element-picker.js
 * （见 package.json 的 electron:dev / electron:build），这里只负责取来注入。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 回调地址的三要素与 picker.rs 的 is_picker_callback 一字不差。 */
const CALLBACK_HOST = 'pick.poietica.invalid'

const ELEMENT_TYPE_LIMIT = 64
const COMMENT_LIMIT = 2_000
/** 快照经查询串回来，上界只为挡住失控的页面，不是内容策略。 */
const REPORT_LIMIT = 64_000

export const PICKER_CANCEL_SCRIPT = 'window.__poieticaElementPicker?.cancel();'

export interface PickerLease {
  readonly tabId: number
  readonly token: number
}

export interface PickedElement {
  readonly elementType: string
  readonly comment: string
  readonly report: string
}

export type PickOutcome =
  | { readonly kind: 'cancelled'; readonly token: number }
  | {
      readonly kind: 'submitted'
      readonly token: number
      readonly submission: 'attach' | 'send'
      readonly element: PickedElement
    }

export interface Picker {
  activeTabId(): number | null
  start(tabId: number): PickerLease
  cancel(tabId: number): PickerLease | null
  cancelActive(): PickerLease | null
  finish(tabId: number, token: number): boolean
}

/** 租约只活在内存里：它是「此刻谁在拾取」，进程重启后没有任何意义。 */
export function createPicker(): Picker {
  let active: PickerLease | null = null
  let nextToken = 0

  return {
    activeTabId: () => active?.tabId ?? null,

    start(tabId) {
      nextToken += 1
      active = { tabId, token: nextToken }

      return active
    },

    cancel(tabId) {
      if (active?.tabId !== tabId) {
        return null
      }

      const lease = active

      active = null

      return lease
    },

    cancelActive() {
      const lease = active

      active = null

      return lease
    },

    finish(tabId, token) {
      if (active?.tabId !== tabId || active.token !== token) {
        return false
      }

      active = null

      return true
    },
  }
}

function clamp(value: string, limit: number): string {
  return [...value].slice(0, limit).join('')
}

/** 标签只进输入框 chip；压成单行并限制长度。 */
function oneLine(value: string): string {
  return clamp(
    value
      .split(/\s+/u)
      .filter((part) => part.length > 0)
      .join(' '),
    ELEMENT_TYPE_LIMIT,
  )
}

export function isPickerCallback(url: string): boolean {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  return (
    parsed.protocol === 'https:' && parsed.hostname === CALLBACK_HOST && parsed.pathname === '/'
  )
}

/** 认不出的回调一律返回 null：宁可当它没发生，也不收半份载荷。 */
export function decodePickerCallback(url: string): PickOutcome | null {
  if (!isPickerCallback(url)) {
    return null
  }

  const params = new URL(url).searchParams
  const rawToken = params.get('token')
  const submission = params.get('submission')

  if (rawToken === null || submission === null || !/^\d+$/u.test(rawToken)) {
    return null
  }

  const token = Number(rawToken)

  if (!Number.isSafeInteger(token)) {
    return null
  }

  if (submission === 'cancel') {
    return { kind: 'cancelled', token }
  }

  if (submission !== 'attach' && submission !== 'send') {
    return null
  }

  const elementType = oneLine(params.get('elementType') ?? '')
  const report = clamp(params.get('report') ?? '', REPORT_LIMIT)

  // 没有元素类型或没有快照的提交是半份载荷：picker.rs 同样拒收。
  if (elementType.length === 0 || report.length === 0) {
    return null
  }

  return {
    kind: 'submitted',
    token,
    submission,
    element: {
      elementType,
      comment: clamp(params.get('comment') ?? '', COMMENT_LIMIT),
      report,
    },
  }
}

export function pickerStartScript(lease: PickerLease, theme: 'light' | 'dark'): string {
  return `window.__poieticaElementPicker.start(${lease.token},'${theme}');`
}

let cachedScript: string | null | undefined

/**
 * 注入脚本的正文。构建期没打出这个文件时返回 null —— 这时拾取按「起不来」处理，
 * 而不是把一段 undefined 注入页面。
 */
export function loadPickerScript(): string | null {
  if (cachedScript !== undefined) {
    return cachedScript
  }

  // 自检要能喂一份脚本文本，不必先跑一遍 bun run electron:build；与 POIETICA_NATIVE 同一个用法。
  const path = process.env['POIETICA_PICKER_SCRIPT'] ?? join(__dirname, 'element-picker.js')

  try {
    cachedScript = readFileSync(path, 'utf8')
  } catch (cause) {
    console.warn('元素拾取脚本没打进 dist-electron/element-picker.js', cause)
    cachedScript = null
  }

  return cachedScript
}

/** 交给 agent 读一次的中转物：落系统临时目录而非数据根，与 paths.rs 的 write_element_report 同一处。 */
export function writeElementReport(report: string): string {
  const directory = join(tmpdir(), 'poietica')

  mkdirSync(directory, { recursive: true })

  const path = join(directory, `element-${randomUUID()}.txt`)

  writeFileSync(path, report, 'utf8')

  return path
}
