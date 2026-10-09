import type { Logger } from '@poietica/foundation'
import { createJsonDocument, type JsonDocument } from '@poietica/fs-kit'
import { z } from 'zod'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const WindowStateSchema = z.object({
  bounds: z.object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().min(960),
    height: z.number().int().min(600),
  }),
  maximized: z.boolean(),
})
export type WindowState = z.infer<typeof WindowStateSchema>

export function defaultWindowState(): WindowState {
  return { bounds: { width: 1280, height: 800 }, maximized: false }
}

/** 纯函数：可见面积不足 100×100 时去掉 x/y（窗口居中），宽高保留 */
export function fitToDisplays(s: WindowState, workAreas: readonly Rect[]): WindowState {
  const { x, y, width, height } = s.bounds
  if (x === undefined || y === undefined) return { bounds: { width, height }, maximized: s.maximized }
  const visible = workAreas.some(
    (area) =>
      Math.max(0, Math.min(x + width, area.x + area.width) - Math.max(x, area.x)) >= 100 &&
      Math.max(0, Math.min(y + height, area.y + area.height) - Math.max(y, area.y)) >= 100,
  )
  return visible ? s : { bounds: { width, height }, maximized: s.maximized }
}

export interface WindowStateStore {
  load(): Promise<WindowState>
  /** 去抖 500ms 落盘 */
  save(s: WindowState): void
  flush(): Promise<void>
}

/**
 * 窗口位置存 <数据根>/window-state.json。读取用 zod 校验，失败用默认值（窗口居中）。
 * 08 页 §6.2：写入走 `createJsonDocument` 的 `saveDebounced`（500ms），退出时 `flush()`。
 */
export function createWindowStateStore(d: {
  file: string
  logger: Logger
  workAreas(): readonly Rect[]
  debounceMs?: number
}): WindowStateStore {
  const doc: JsonDocument<WindowState> = createJsonDocument({
    file: d.file,
    schema: WindowStateSchema,
    defaults: defaultWindowState,
    logger: d.logger,
    ...(d.debounceMs === undefined ? {} : { debounceMs: d.debounceMs }),
  })

  return {
    async load() {
      const loaded = await doc.load()
      // 显示器被拔掉后旧坐标可能落在屏幕外：这时只保留宽高，让窗口居中
      return fitToDisplays(loaded, d.workAreas())
    },
    save(s) {
      // 坐标已经过 fitToDisplays（save 的调用方给的是窗口当前值，必然可见）
      doc.saveDebounced(s)
    },
    async flush() {
      await doc.flush()
    },
  }
}
