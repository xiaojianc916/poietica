import { isProblem, ProblemError } from '@poietica/problem'

/**
 * 一次原生调用只有这一条路：Problem 形状的裸对象在这里成为 ProblemError；
 * 认不出来的异常原样上抛，不许被折成一句"操作失败"。
 */
export async function throughIpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isProblem(error)) {
      throw new ProblemError(error)
    }

    throw error
  }
}
