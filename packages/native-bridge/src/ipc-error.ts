import { isProblem, ProblemError } from '@poietica/problem'

/**
 * 一次原生调用只有这一条路：Problem 形状的裸对象在这里成为 ProblemError；
 * 认不出来的异常原样上抛，不许被折成一句"操作失败"。
 *
 * 两处来源都要认：Electron 的 IPC 会把异常压成一句 message，所以 preload 抛的是
 * `Error('poietica: <code>')` **挂着** `problem`（preload.ts:72）—— 只认裸对象的话，
 * 它落进「认不出来」那一支，屏幕上是 `Error: poietica: agentRejected` 这样一句码，
 * 真正说明原因的 `details.reason` 与文案目录键全被丢掉。
 */
export async function throughIpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isProblem(error)) {
      throw new ProblemError(error)
    }

    /* preload 把信封挂在异常上（见上）；裸对象与它挂的那一份走同一条折法。 */
    const attached =
      typeof error === 'object' && error !== null && 'problem' in error
        ? (error as { readonly problem?: unknown }).problem
        : undefined

    if (isProblem(attached)) {
      throw new ProblemError(attached)
    }

    throw error
  }
}
