import type { AnyMethod, Contract, MethodName, ParamsOut, ResultOf } from '@poietica/contract-kit'
import { AppError, type Disposable, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import type { InboundContext } from './peer'

export type TypedHandler<C extends Contract, N extends MethodName<C>> = (
  params: ParamsOut<C, N>,
  ctx: InboundContext,
) => Promise<ResultOf<C, N>> | ResultOf<C, N>

export class Router {
  private readonly handlers = new Map<
    string,
    { def: AnyMethod; fn: (p: unknown, c: InboundContext) => Promise<unknown> }
  >()

  /** 注册一个方法的实现。def 来自契约；参数在这里用 zod 校验，handler 拿到的一定是合法的 output 类型。 */
  register(def: AnyMethod, fn: (params: unknown, ctx: InboundContext) => unknown): Disposable {
    if (this.handlers.has(def.name)) throw new AppError(SystemErrorCode.conflict, `${def.name} 重复注册`)
    this.handlers.set(def.name, {
      def,
      fn: async (raw, ctx) => {
        const parsed = def.params.safeParse(raw ?? {})
        if (!parsed.success)
          throw new AppError(SystemErrorCode.invalidParams, z.prettifyError(parsed.error), {
            issues: parsed.error.issues,
          })
        return fn(parsed.data, ctx)
      },
    })
    return {
      dispose: () => {
        this.handlers.delete(def.name)
      },
    }
  }

  has(method: string): boolean {
    return this.handlers.has(method)
  }

  names(): readonly string[] {
    return [...this.handlers.keys()]
  }

  async handle(method: string, params: unknown, ctx: InboundContext): Promise<unknown> {
    const h = this.handlers.get(method)
    if (h === undefined) throw new AppError(SystemErrorCode.methodNotFound, `未知方法 ${method}`)
    return h.fn(params, ctx)
  }
}
