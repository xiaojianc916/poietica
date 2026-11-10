import { AppError, SystemErrorCode } from '@poietica/foundation'
import type { AgentEngine, EngineSession } from '@poietica/runtime-protocol'
import {
  type ArpEventParams,
  arpMethods,
  arpRunSubmitParams,
  arpSessionOpenParams,
  arpSessionPageParams,
} from '@poietica/runtime-protocol'
import type { z } from 'zod'

/**
 * omp Runtime Worker 的 ARP 方法表：只做「参数校验 → 调 AgentEngine → 交回结果」，
 * 不持有 Core 的领域状态。会话事件经 `runtime.event` 原样流出，Worker 不认识产品投影。
 */
export interface ArpHandlersDeps {
  readonly engine: AgentEngine
  readonly emit: (p: ArpEventParams) => void
}

export interface ArpHandlers {
  readonly handlers: Readonly<Record<string, (params: unknown) => unknown>>
  readonly dispose: () => Promise<void>
}

function parse<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params)
  if (!result.success) throw new AppError(SystemErrorCode.invalidParams, 'ARP 参数无效')
  return result.data
}

export function createArpHandlers(d: ArpHandlersDeps): ArpHandlers {
  const sessions = new Map<string, { session: EngineSession; dispose: () => void }>()

  const close = async (key: string): Promise<void> => {
    const held = sessions.get(key)
    if (held === undefined) return
    sessions.delete(key)
    held.dispose()
    await held.session.dispose()
  }

  return {
    handlers: {
      [arpMethods.sessionOpen]: async (params) => {
        const input = parse(arpSessionOpenParams, params)
        await close(input.key)
        const session = await d.engine.openSession({
          key: input.key,
          cwd: input.cwd,
          sessionFile: input.sessionFile,
          posture: input.posture,
          model: input.model,
          thinking: input.thinking,
          ...(input.autoTitle === undefined ? {} : { autoTitle: input.autoTitle }),
        })
        const subscription = session.subscribe((event) => d.emit({ key: input.key, event }))
        sessions.set(input.key, { session, dispose: () => subscription.dispose() })
        return { sessionId: session.sessionId, sessionFile: session.sessionFile }
      },
      [arpMethods.sessionPage]: async (params) => {
        const input = parse(arpSessionPageParams, params)
        const held = sessions.get(input.key)
        if (held === undefined) throw new AppError(SystemErrorCode.notFound, `会话未打开：${input.key}`)
        return held.session.page(
          input.agentId,
          input.beforeTurnId,
          input.throughTurnId === undefined ? undefined : { throughTurnId: input.throughTurnId },
        )
      },
      [arpMethods.runSubmit]: async (params) => {
        const input = parse(arpRunSubmitParams, params)
        const held = sessions.get(input.key)
        if (held === undefined) throw new AppError(SystemErrorCode.notFound, `会话未打开：${input.key}`)
        await held.session.submit({
          text: input.text,
          images: input.images,
          files: input.files,
          skills: input.skills,
          deliverAs: input.deliverAs,
          ...(input.ref === undefined ? {} : { ref: input.ref }),
          ...(input.context === undefined ? {} : { context: input.context }),
        })
        return {}
      },
      [arpMethods.runCancel]: async (params) => {
        const input = parse(arpSessionOpenParams.pick({ key: true }), params)
        const held = sessions.get(input.key)
        if (held === undefined) throw new AppError(SystemErrorCode.notFound, `会话未打开：${input.key}`)
        await held.session.cancel()
        return {}
      },
      [arpMethods.sessionClose]: async (params) => {
        const input = parse(arpSessionOpenParams.pick({ key: true }), params)
        await close(input.key)
        return {}
      },
    },
    async dispose() {
      await Promise.all([...sessions.keys()].map((key) => close(key)))
    },
  }
}
