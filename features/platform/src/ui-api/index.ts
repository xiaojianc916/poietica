import { type Disposable, defineServiceToken } from '@poietica/foundation'

/**
 * 关闭拦截的注册面。platform 不认识 conversation：它只提供这个令牌，
 * conversation 注册“有运行中的线程时先确认”的处理器。依赖方向因此是 conversation → platform。
 */
export interface WindowCloseGuard {
  /** 返回 false 表示取消退出 */
  onCloseRequested(handler: () => Promise<boolean>): Disposable
}

export const WindowCloseToken = defineServiceToken<WindowCloseGuard>('platform', 'WindowClose')
