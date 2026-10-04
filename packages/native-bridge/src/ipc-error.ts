import { isProblem, ProblemError } from '@poietica/problem'

/**
 * 一次原生调用只有这一条路：Problem 形状的裸对象在这里成为 ProblemError；
 * 认不出来的异常原样上抛，不许被折成一句"操作失败"。
 *
 * 两种来源都要认，因为两边都真实存在：
 * 1. preload 抛的是**裸对象**（apps/desktop/electron/preload.ts）—— contextBridge 过不去
 *    Error 的自定义属性，所以那一条只能抛对象本身。
 * 2. 但**挂在异常上的那一份也要认**：进程内的调用方（测试、以及将来任何直接调 host 的
 *    地方）会按 `Object.assign(new Error(...), { problem })` 这个形状交给它。少认这一支，
 *    那些调用方拿到的就是一句 `poietica: agentRejected` 的码，而 details.reason 全丢。
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
