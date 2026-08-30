import { type DiffFile, parseUnifiedPatch } from '@poietica/review'

import { paint } from './syntax'

/*
 * 审查的重活住在这里：解析、词级差异、语法着色都是纯 CPU，万行补丁在主线程
 * 跑一遍就是数秒的冻结。协议正本：一次请求一份补丁，回答按 id 配对。
 */
interface Request {
  readonly id: number
  readonly patch: string
  readonly wordDiff: boolean
}
interface Reply {
  readonly files?: readonly DiffFile[]
  readonly id: number
  readonly trouble?: string
}
/* DOM 与 WebWorker 两条 lib 对 self 的说法打架：按本文件需要的形状收窄一次。 */
const port = self as unknown as {
  addEventListener(kind: 'message', listener: (event: MessageEvent<Request>) => void): void
  postMessage(message: Reply): void
}
port.addEventListener('message', (event) => {
  const { id, patch, wordDiff } = event.data
  void (async () => {
    try {
      const files = await paint(parseUnifiedPatch(patch, wordDiff))
      port.postMessage({ files, id })
    } catch (cause) {
      port.postMessage({ id, trouble: String(cause) })
    }
  })()
})
