import type { MainWindowController } from '@poietica/desktop-adapters'
import { reportFailure } from '../failures/application-policy'

/**
 * 把窗口层的衬底色对齐到当前主题。
 *
 * 拖动与缩放时新扩展出来的区域填的是窗口层底色 —— 下一帧到位之前那块就是它。读的
 * 是 <html> 上真正生效的 background-color（app.css 里它就是 --window-backing-surface），
 * 推给原生的与屏幕上的因此必然同一个值，不存在第二份颜色。
 */
export function alignWindowBackingColor(mainWindow: MainWindowController): void {
  const backing = getComputedStyle(document.documentElement).backgroundColor

  void mainWindow.setBackingColor(backing).catch((cause: unknown) => {
    reportFailure('WINDOW_BACKING_COLOR_UNAVAILABLE', {
      scope: 'window-chrome',
      operation: 'align-window-backing-color',
      cause,
    })
  })
}
