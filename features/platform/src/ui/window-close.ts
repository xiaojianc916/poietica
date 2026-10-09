import type { Disposable } from '@poietica/foundation'
import type { WindowCloseGuard } from '../ui-api'
import type { PlatformApi } from './api'

/**
 * 关闭拦截：收到 window.closeRequested 时依次询问已注册的处理器，
 * 全部返回 true 才调用 app.quit。
 */
export function createWindowCloseGuard(api: PlatformApi): WindowCloseGuard & { bind(): Disposable } {
  const handlers: Array<() => Promise<boolean>> = []
  return {
    onCloseRequested(handler) {
      handlers.push(handler)
      return {
        dispose: () => {
          const i = handlers.indexOf(handler)
          if (i >= 0) handlers.splice(i, 1)
        },
      }
    },
    bind() {
      return api.onCloseRequested(() => {
        void (async () => {
          for (const handler of [...handlers]) {
            // 任何一步出错都当作“不放行”，避免带着半截状态退出
            if (!(await handler().catch(() => false))) return
          }
          await api.quit()
        })()
      })
    },
  }
}
