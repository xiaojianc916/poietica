import { AppError } from '@poietica/foundation'
import { intelligentUiErrors } from '../contract'

/*
 * 「复制为图片」：UI 量出界面在主窗口里的矩形（CSS 像素），Host 用 webContents.capturePage 截下来放进剪贴板。
 * 截的是窗口里正画着的那一块 —— 跨源 iframe 的像素 UI 进程读不到（canvas 会被污染），只能由 Host 从合成结果里取。
 *
 * capturePage 的矩形是 DIP：CSS 像素乘页面缩放（Ctrl +/-）才是 DIP。超出内容区的部分裁掉（界面一部分滚出了视口），
 * 裁完不剩东西就是 null。
 */

export interface CaptureRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function captureRectOf(
  rect: CaptureRect,
  zoom: number,
  content: { readonly width: number; readonly height: number },
): CaptureRect | null {
  /* 内容区量坏了（窗口还没布局、hidden 时给 0/NaN）：没有可截的矩形，别让下面的 Math.min 造出负尺寸 */
  if (
    !Number.isFinite(content.width) ||
    !Number.isFinite(content.height) ||
    content.width <= 0 ||
    content.height <= 0
  ) {
    return null
  }
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const left = Math.max(0, Math.floor(rect.x * scale))
  const top = Math.max(0, Math.floor(rect.y * scale))
  const right = Math.min(content.width, Math.ceil((rect.x + rect.width) * scale))
  const bottom = Math.min(content.height, Math.ceil((rect.y + rect.height) * scale))
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 剪贴板写入失败的业务映射：日志在调用处记（带 cause），这里只负责把底层异常收成稳定的错误码。 */
export function clipboardFailureOf(cause: unknown): AppError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new AppError(intelligentUiErrors.capture_failed, '没能把图片写进剪贴板', { cause: detail })
}
